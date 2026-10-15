#!/usr/bin/env python3
"""Run unchanged assertions against a prepared SHA; never interpret missing tests as PASS."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("preparation", type=Path)
args = parser.parse_args()
report_dir = args.preparation.parent
junit = report_dir / "safety.junit.xml"
result_file = report_dir / "safety-results.json"
# Remove prior evidence before validation too: an invalid preparation must not
# leave an earlier successful result available to be mistaken for this run.
junit.unlink(missing_ok=True)
result_file.unlink(missing_ok=True)
prep = json.loads(args.preparation.read_text())
assert prep["schema"] == "pr90-retest-preparation-v1"
root = Path(prep["testRoot"])
for name, digest in prep["testSha256"].items():
    assert hashlib.sha256((root / name).read_bytes()).hexdigest() == digest, name
assert json.loads((root / "source-pins.json").read_text()) == prep["pins"]
registry = json.loads((Path(__file__).parent / "safety-cases.json").read_text())
env = dict(os.environ, PR90_REQUIRE_SAFE="1", PR90_REVIEW_ROOT=prep["sourceRoot"], NO_COLOR="1")
command = ["deno", "test", "--cached-only", "--allow-read", "--allow-env",
           "--allow-net=127.0.0.1", "--junit-path", str(junit),
           str(root / "verify.ts"), str(root / "egress.ts")]
with (report_dir / "safety.log").open("w") as log:
    process = subprocess.run(command, env=env, stdout=log, stderr=subprocess.STDOUT, check=False)
cases = []
if junit.exists():
    cases = list(ET.parse(junit).getroot().iter("testcase"))
rows = []
for bug in registry["bugs"]:
    matches = [c for c in cases if c.attrib.get("name", "").startswith(bug["id"] + " ")]
    status = "NOT_RUN"
    if len(matches) == 1:
        case = matches[0]
        if case.find("skipped") is None:
            status = "FAIL" if case.find("failure") is not None or case.find("error") is not None else "PASS"
    rows.append({"id": bug["id"], "severity": bug["severity"],
                 "original_failure": bug["original_failure"],
                 "fix_sha": None if prep["reviewedSha"] == registry["original_source_sha"] else prep["reviewedSha"],
                 "retest_sha": prep["reviewedSha"], "retest": status,
                 "expected_safe_behavior": bug["expected_safe_behavior"],
                 "remaining_risk": bug["remaining_risk"], "matching_test_count": len(matches)})
failed = sum(c.find("failure") is not None or c.find("error") is not None for c in cases)
skipped = sum(c.find("skipped") is not None for c in cases)
result = {"schema": "pr90-seven-bug-retest-v1", "reviewed_sha": prep["reviewedSha"],
          "original_test_commit": prep["originalCommit"],
          "unchanged_test_modules": prep["unchangedTestModules"],
          "source_and_test_hashes_verified": True,
          "command_exit_code": process.returncode,
          "passed": len(cases) - failed - skipped, "failed": failed, "skipped": skipped,
          "bugs": rows, "all_seven_pass": all(r["retest"] == "PASS" for r in rows),
          "authorizes_live_execution": False,
          "actual_vendor_receipts": [], "actual_vendor_spend_usd": None}
result_file.write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result, indent=2))
sys.exit(process.returncode if process.returncode else (0 if result["all_seven_pass"] else 1))
