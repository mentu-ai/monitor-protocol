#!/usr/bin/env python3
"""
Monitor Protocol v0 conformance suite (spec/05-conformance.md, C01–C21).

    python3 run.py --base http://127.0.0.1:8124 [--atrio] [--subjects g1,g2,g3] [--json]

Black-box over the REST binding. Needs three lease subjects (work items the server knows);
`--atrio` creates them through Atrio's `/api/entries`, otherwise pass `--subjects`. Each check
prints PASS / FAIL / SKIP(reason). Exit code 1 on any FAIL. Stdlib only.
"""
import argparse
import json
import sys
import threading
import time
import urllib.error
import urllib.request


class Client:
    def __init__(self, base):
        self.base = base.rstrip("/")

    def req(self, method, path, body=None, token=None, timeout=15):
        h = {"Content-Type": "application/json"}
        if token:
            h["Authorization"] = "Bearer " + token
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(self.base + path, method=method, data=data, headers=h)
        try:
            with urllib.request.urlopen(r, timeout=timeout) as resp:
                raw = resp.read(); st = resp.status
        except urllib.error.HTTPError as e:
            raw = e.read(); st = e.code
        try:
            return st, json.loads(raw or b"{}")
        except Exception:
            return st, raw


class Suite:
    def __init__(self, c, subjects, verbose=True, admin_token=None):
        self.c, self.subjects, self.results, self.verbose = c, list(subjects), [], verbose
        self.admin_token = admin_token
        self.tag = str(int(time.time()))[-6:]

    # ---- helpers
    def record(self, cid, status, note=""):
        self.results.append({"id": cid, "status": status, "note": note})
        if self.verbose:
            print(f"{cid} {status}{(' — ' + note) if note else ''}")

    def check(self, cid, cond, note="", fail_note=""):
        self.record(cid, "PASS" if cond else "FAIL", note if cond else (fail_note or note))
        return cond

    def monitor(self, name, **kw):
        body = dict({"id": f"c-{name}-{self.tag}", "name": name, "horizon": "minute",
                     "capabilities": ["observe", "react", "act"], "visibility": "public",
                     "types": ["test.conformance.reading", "test.conformance.contradiction",
                               "test.conformance.contradiction_resolved"],
                     "source": {"kind": "shell", "ref": "conformance"}}, **kw)
        st, out = self.c.req("POST", "/mp/v0/monitors", body)
        assert st == 201, (st, out)
        return out["monitor"]["id"], out["owner_token"]

    def subscribe(self, mid, who, caps=("observe",), grant=None, **kw):
        st, out = self.c.req("POST", "/mp/v0/subscriptions",
                             dict({"monitor": mid, "subscriber": f"{who}-{self.tag}", "capabilities": list(caps)}, **kw),
                             token=grant)
        assert st == 201, (st, out)
        return out["subscription"]["id"], out["token"], out["subscription"]

    def publish(self, mid, tok, **kw):
        body = dict({"type": "test.conformance.reading", "subject": "probe-1",
                     "data": {"value": 1}, "tier": "measured", "origin": "probe"}, **kw)
        return self.c.req("POST", f"/mp/v0/monitors/{mid}/observations", body, token=tok)

    def pull(self, sid, tok, **q):
        qs = "&".join(f"{k}={v}" for k, v in q.items())
        return self.c.req("GET", f"/mp/v0/subscriptions/{sid}/pull" + (("?" + qs) if qs else ""), token=tok)

    # ---- checks
    def run(self):
        c = self.c
        st, d = c.req("GET", "/mp/v0/discover")
        self.check("C01", st == 200 and all(k in d for k in ("supportedVersions", "capabilities", "serverInfo", "ttlMs")),
                   fail_note=f"{st} {d}")

        mid, otok = self.monitor("base")
        st, out = c.req("POST", "/mp/v0/subscriptions", {"monitor": mid, "subscriber": "x", "filter": {"typo": ["a"]}})
        self.check("C02", st == 400 and out.get("code") == "INVALID_FILTER" and "known_keys" in out, fail_note=f"{st} {out}")
        st, out = c.req("POST", "/mp/v0/subscriptions", {"monitor": mid, "subscriber": "x",
                                                         "filter": {"types": ["test.conformance.nothing"]}})
        self.check("C03", st == 400 and out.get("code") == "INVALID_FILTER" and "known_types" in out, fail_note=f"{st} {out}")

        st, out = self.publish(mid, otok, tier="src", origin="agent")
        self.check("C04", st == 400 and out.get("code") == "TIER_NOT_ASSERTABLE", fail_note=f"{st} {out}")

        sid, stok, sub = self.subscribe(mid, "reader")
        for i in range(3):
            st, out = self.publish(mid, otok, data={"value": i})
            assert st == 201, (st, out)
        st, p1 = self.pull(sid, stok)
        st2, p2 = self.pull(sid, stok)
        ids1 = [o["id"] for o in p1.get("observations", [])]
        ids2 = [o["id"] for o in p2.get("observations", [])]
        self.check("C05", st == 200 and ids1 and ids1 == ids2 and p1["cursor"] == p2["cursor"],
                   fail_note=f"{ids1} vs {ids2}")
        readings = [o for o in p1.get("observations", []) if o["type"] == "test.conformance.reading"]
        self.check("C09", bool(readings) and all(all(k in o for k in ("specversion", "id", "source", "type", "time",
                                                                          "sequence", "tier", "origin", "verified",
                                                                          "horizon", "actor")) for o in readings)
                   and all(o["specversion"] == "1.0" for o in readings), fail_note=json.dumps(readings[:1]))
        seqs = [o["sequence"] for o in p1.get("observations", [])]
        self.check("C10", all(len(s) == 20 and s.isdigit() for s in seqs) and seqs == sorted(seqs) and len(set(seqs)) == len(seqs),
                   fail_note=str(seqs[:3]))

        nxt = p1["next"]
        st, a1 = c.req("POST", f"/mp/v0/subscriptions/{sid}/ack", {"cursor": nxt}, token=stok)
        st_b, back = c.req("POST", f"/mp/v0/subscriptions/{sid}/ack", {"cursor": max(0, nxt - 1)}, token=stok)
        st_e, again = c.req("POST", f"/mp/v0/subscriptions/{sid}/ack", {"cursor": nxt}, token=stok)
        self.check("C06", st == 200 and st_b == 409 and back.get("code") == "CURSOR_BACKWARDS" and st_e == 200 and again == a1,
                   fail_note=f"{st_b} {back} / {again} vs {a1}")
        self.check("C20", st_e == 200 and again == a1, note="ack idempotent")

        nid, ntok, _ = self.subscribe(mid, "narrow", filter={"types": ["test.conformance.contradiction"]})
        st, pn = self.pull(nid, ntok)
        st, pw = self.pull(sid, stok)
        self.check("C07", pn["head"] == pw["head"] and pn.get("observations") == [], fail_note=f"{pn['head']} vs {pw['head']}")

        st, wide = self.pull(nid, ntok, types="test.conformance.reading")
        self.check("C08", st == 400 and wide.get("code") == "INVALID_FILTER", fail_note=f"{st} {wide}")

        oid, otok2, _ = self.subscribe(mid, "observer-only")
        subj = self.subjects[0]
        st, out = c.req("POST", f"/mp/v0/subscriptions/{oid}/leases/claim", {"subject": subj}, token=otok2)
        self.check("C11", st == 403 and out.get("code") == "CAPABILITY_MISSING", fail_note=f"{st} {out}")

        a_id, a_tok, _ = self.subscribe(mid, "worker-a", caps=("observe", "act"), grant=otok)
        b_id, b_tok, _ = self.subscribe(mid, "worker-b", caps=("observe", "act"), grant=otok)
        res = {}
        def go(name, sid_, tok_):
            res[name] = c.req("POST", f"/mp/v0/subscriptions/{sid_}/leases/claim",
                              {"subject": self.subjects[1], "lease_duration_seconds": 60}, token=tok_)
        ts = [threading.Thread(target=go, args=("a", a_id, a_tok)), threading.Thread(target=go, args=("b", b_id, b_tok))]
        [t.start() for t in ts]; [t.join() for t in ts]
        codes = sorted(r[0] for r in res.values())
        loser = [r[1] for r in res.values() if r[0] == 409]
        self.check("C12", codes == [201, 409] and loser and loser[0].get("code") == "LEASE_HELD" and loser[0].get("holder"),
                   fail_note=str(res))
        winner = "a" if res["a"][0] == 201 else "b"
        w_id, w_tok = (a_id, a_tok) if winner == "a" else (b_id, b_tok)
        st, rep = c.req("POST", f"/mp/v0/subscriptions/{w_id}/leases/claim",
                        {"subject": self.subjects[1], "lease_duration_seconds": 60}, token=w_tok)
        self.check("C20b", st == 200 and rep.get("idempotent") is True, note="claim idempotent", fail_note=f"{st} {rep}")

        st, out = c.req("POST", f"/mp/v0/subscriptions/{a_id}/leases/claim",
                        {"subject": self.subjects[2], "lease_duration_seconds": 1}, token=a_tok)
        assert st in (200, 201), (st, out)
        time.sleep(2.5)   # leases expire at second resolution: 1 s lease + truncation needs > 2 s
        st, out = c.req("POST", f"/mp/v0/subscriptions/{b_id}/leases/claim",
                        {"subject": self.subjects[2], "lease_duration_seconds": 60}, token=b_tok)
        st2, lost = c.req("POST", f"/mp/v0/subscriptions/{a_id}/leases/complete",
                          {"subject": self.subjects[2], "outcome": "done"}, token=a_tok)
        self.check("C13", st in (200, 201) and st2 == 409 and lost.get("code") == "LEASE_LOST", fail_note=f"{st} {out} / {st2} {lost}")

        wit_id, wit_tok, _ = self.subscribe(mid, "witness", filter={"types": ["ai.mentu.monitor.*"]})
        c.req("POST", f"/mp/v0/monitors/{mid}/pause", {"reason": "c14"}, token=otok)
        c.req("POST", f"/mp/v0/monitors/{mid}/resume", {"reason": "c14"}, token=otok)
        c.req("POST", f"/mp/v0/subscriptions/{oid}/retire", {"reason": "c14"}, token=otok2)
        st, pw = self.pull(wit_id, wit_tok, limit=200)
        types = [(o["type"], (o["data"].get("payload") or {}).get("action")) for o in pw.get("observations", [])]
        have = {("ai.mentu.monitor.configured", "pause"), ("ai.mentu.monitor.configured", "resume")} <= set(types) and \
               any(t == "ai.mentu.monitor.subscription_retired" for t, _ in types)
        self.check("C14", have, fail_note=str(types[-8:]))

        st, s_ = c.req("GET", f"/mp/v0/monitors/{mid}/state")
        conf = s_.get("confidence") or {}
        self.check("C15", st == 200 and all(k in s_ for k in ("as_of", "covers_until", "live", "confidence"))
                   and isinstance(s_["live"], dict) and "value" in s_["live"] and "reason" in s_["live"]
                   and "inputs" in conf and "missing" in conf["inputs"] and "gaps" in conf
                   and (conf.get("value") is None or conf["inputs"]["missing"] == []),
                   fail_note=json.dumps(s_)[:300])

        st, rej = self.publish(mid, otok, tier="nonsense")
        st2, pw = self.pull(wit_id, wit_tok, limit=200)
        rejected = [o for o in pw.get("observations", []) if o["type"] == "ai.mentu.monitor.rejected"]
        self.check("C16", st == 400 and rej.get("code") == "UNKNOWN_VOCABULARY" and rejected
                   and (rejected[-1]["data"].get("payload") or {}).get("raw", {}).get("tier") == "nonsense",
                   fail_note=f"{st} {rej} / {len(rejected)}")

        # C22 — what was acked does not come back; the ack is computed from the spec, not echoed.
        p4_id, p4_tok, _ = self.subscribe(mid, "p4-reader")
        st, before = self.pull(p4_id, p4_tok, limit=200)
        seen = [int(o["id"]) for o in before.get("observations", [])]
        ack_to = max(seen) + 1 if seen else 0
        c.req("POST", f"/mp/v0/subscriptions/{p4_id}/ack", {"cursor": ack_to}, token=p4_tok)
        st, after = self.pull(p4_id, p4_tok, limit=200)
        came_back = [int(o["id"]) for o in after.get("observations", []) if int(o["id"]) in seen]
        self.check("C22", bool(seen) and not came_back, f"acked {ack_to}; {len(came_back)} acked observations came back")

        # C23 — a wrong credential is refused; without this a server with no auth passes.
        st_bad, bad = c.req("GET", f"/mp/v0/subscriptions/{p4_id}/pull", token="not-the-token")
        st_none, _ = c.req("GET", f"/mp/v0/subscriptions/{p4_id}/pull")
        self.check("C23", st_bad == 401 and st_none == 401 and bad.get("code") == "UNAUTHORIZED",
                   f"wrong token {st_bad}, none {st_none}")

        # C24 — the positive control: a completion that succeeds.
        st_cl, _ = c.req("POST", f"/mp/v0/subscriptions/{a_id}/leases/claim",
                         {"subject": self.subjects[0], "lease_duration_seconds": 60}, token=a_tok)
        st_co, co = c.req("POST", f"/mp/v0/subscriptions/{a_id}/leases/complete",
                          {"subject": self.subjects[0], "outcome": "done"}, token=a_tok)
        self.check("C24", st_cl in (200, 201) and st_co == 200 and co.get("ok") is True, f"claim {st_cl}, complete {st_co} {co}")

        # C25 — head and lag belong to the monitor and the subscription.
        q_id, q_tok, _ = self.subscribe(mid, "quiet-reader")
        st, q1 = self.pull(q_id, q_tok, limit=200)
        q_seen = [int(o["id"]) for o in q1.get("observations", [])]
        c.req("POST", f"/mp/v0/subscriptions/{q_id}/ack", {"cursor": (max(q_seen) + 1) if q_seen else 0}, token=q_tok)
        st, caught = self.pull(q_id, q_tok, limit=1)
        oid, otok2 = self.monitor("other")
        self.publish(oid, otok2, subject="elsewhere")
        st, after_other = self.pull(q_id, q_tok, limit=1)
        self.check("C25", caught.get("lag") == 0 and after_other.get("lag") == 0 and after_other.get("head") == caught.get("head"),
                   f"lag {caught.get('lag')} -> {after_other.get('lag')}, head {caught.get('head')} -> {after_other.get('head')}")

        # C26 — the ceiling, probed with the inputs the earlier checks do not send.
        escapes = []
        for label, body in (("tier src, origin omitted", {"tier": "src"}),
                            ("tier src, origin human", {"tier": "src", "origin": "human"}),
                            ("human origin from a non-human actor", {"origin": "human", "actor": "agent:evil"}),
                            ("agent self-certifying", {"origin": "agent", "verification": "human_verified"})):
            st_p, out_p = self.publish(mid, otok, **body)
            o = (out_p or {}).get("observation") or {}
            if st_p < 400 and (o.get("tier") == "src" or o.get("origin") == "human"
                               or o.get("verified") in ("human_verified", "certified")):
                escapes.append(f"{label} -> tier={o.get('tier')} origin={o.get('origin')} verified={o.get('verified')}")
        self.check("C26", not escapes, "; ".join(escapes))

        # C27 — a cursor that is not an integer is refused, not turned into NaN.
        st_n, n_body = c.req("POST", f"/mp/v0/subscriptions/{p4_id}/ack", {"cursor": "abc"}, token=p4_tok)
        st_np, _ = self.pull(p4_id, p4_tok, cursor="abc")
        self.check("C27", st_n == 400 and st_np == 400, f"ack {st_n} {n_body}, pull {st_np}")

        # C28 — capabilities are granted, not requested.
        st_s, s_body = c.req("POST", "/mp/v0/subscriptions",
                             {"monitor": mid, "subscriber": f"stranger-{self.tag}", "capabilities": ["observe", "act"]})
        self.check("C28", st_s == 403 and s_body.get("code") == "CAPABILITY_MISSING", f"{st_s} {s_body}")

        pid, ptok = self.monitor("private", visibility="private")
        st, lst = c.req("GET", "/mp/v0/monitors")
        st2, lst2 = c.req("GET", "/mp/v0/monitors", token=ptok)
        ids_anon = {m["id"] for m in lst.get("monitors", [])}
        ids_own = {m["id"] for m in lst2.get("monitors", [])}
        self.check("C18", pid not in ids_anon and pid in ids_own and mid in ids_anon, fail_note=f"{pid in ids_anon} {pid in ids_own}")

        m_id, m_tok, m_sub = self.subscribe(mid, "mute", retire_after_mute_seconds=1)
        st, pm = self.pull(m_id, m_tok)
        c.req("POST", f"/mp/v0/subscriptions/{m_id}/ack", {"cursor": pm["next"]}, token=m_tok)
        time.sleep(2.5)   # retire_after_mute_seconds=1 at second resolution
        c.req("GET", "/mp/v0/discover")
        st, gone = self.pull(m_id, m_tok)
        st2, pw = self.pull(wit_id, wit_tok, limit=200)
        will = [o for o in pw.get("observations", []) if o["type"] == "ai.mentu.monitor.subscription_retired"
                and (o["data"].get("payload") or {}).get("subscription") == m_id]
        st3, re_ = c.req("POST", "/mp/v0/subscriptions", {"monitor": mid, "subscriber": f"mute-{self.tag}",
                                                          "capabilities": ["observe"]})
        kept = st3 == 201 and re_["subscription"]["cursor"] == pm["next"] and re_["subscription"]["id"] == m_id
        self.check("C19", st == 404 and gone.get("retired") is True and will and kept,
                   fail_note=f"{st} {gone} / will={len(will)} / kept={kept}")

        st, o1 = self.publish(mid, otok, data={"value": 41})
        orig = o1["observation"]
        st, o2 = self.publish(mid, otok, data={"value": 42}, supersedes={"source": orig["source"], "id": orig["id"]})
        st3, pw = self.pull(sid, stok, cursor=int(orig["id"]) - 1, limit=200)
        same = [o for o in pw.get("observations", []) if o["id"] == orig["id"]]
        sup = o2.get("observation", {}).get("data", {}).get("provenance", {}).get("supersedes")
        self.check("C21", st == 201 and sup == {"source": orig["source"], "id": orig["id"]} and same
                   and same[0]["data"].get("value") == 41, fail_note=f"{sup} / {same[:1]}")
        # Compaction is destructive, so the expiry check runs last. A server that can be compacted
        # exposes it under an admin token; one that retains everything records the skip and says why.
        st, p0 = self.pull(sid, stok, limit=1)
        if self.admin_token:
            c.req("POST", "/mp/v0/admin/compact", {"upto_seq": max(1, p0.get("head", 1) - 1)}, token=self.admin_token)
        st, p0 = self.pull(sid, stok, limit=1)
        floor = p0.get("retention_floor", 0)
        if floor and floor > 1:
            st, ex = self.pull(sid, stok, cursor=0)
            self.check("C17", st == 410 and ex.get("code") == "CURSOR_EXPIRED" and "retention_floor" in ex and "relist" in ex,
                       fail_note=f"{st} {ex}")
        else:
            self.record("C17", "SKIP", f"server retains everything (retention_floor={floor}); expiry path not exercisable")

        return self.results


def make_subjects_atrio(c, n=3, space="crawlio"):
    """Atrio-specific: a lease subject there is an entry genesis, so mint three entries."""
    out = []
    for i in range(n):
        st, r = c.req("POST", "/api/entries", {"kind": "ticket", "space": space, "title": f"conformance subject {i}",
                                               "actor": "rashid", "requester": "rashid"})
        assert st == 201, (st, r)
        out.append(r["genesis"])
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--atrio", action="store_true", help="create lease subjects through Atrio's /api/entries")
    ap.add_argument("--space", default="crawlio", help="Atrio space to mint subjects in (--atrio only)")
    ap.add_argument("--subjects", help="comma-separated work-item ids the server knows")
    ap.add_argument("--admin-token", help="token for the optional admin endpoints (C17)")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    c = Client(a.base)
    subjects = a.subjects.split(",") if a.subjects else (make_subjects_atrio(c, space=a.space) if a.atrio else [])
    if len(subjects) < 3:
        print("need three lease subjects (--atrio or --subjects)"); return 2
    res = Suite(c, subjects, verbose=not a.json, admin_token=a.admin_token).run()
    fails = [r for r in res if r["status"] == "FAIL"]
    summary = {"suite": "monitor-protocol-conformance", "version": "0.1", "base": a.base,
               "pass": sum(r["status"] == "PASS" for r in res), "fail": len(fails),
               "skip": sum(r["status"] == "SKIP" for r in res), "results": res}
    if a.json:
        print(json.dumps(summary, indent=1))
    else:
        print(f"\n{summary['pass']} PASS · {summary['fail']} FAIL · {summary['skip']} SKIP")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
