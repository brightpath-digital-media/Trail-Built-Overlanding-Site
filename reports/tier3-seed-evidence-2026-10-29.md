# Tier 3 seed evidence

As-of date: 2026-10-29. Window: 45 days (author date, UTC, inclusive). Main ref: origin/main.
Produced by `scripts/seed-verified-from-history.mjs`. Audit any row with `git show --stat <SHA>` and `git log -1 --format=%aI <SHA>`.

Limitation: the later `Verify Deploy Live` conclusion of each run cannot be read offline. Evidence that the run passed
is limited to: a normal `chore: auto-publish` commit that is on main, whose article is still present at HEAD with the ASIN still on the page.
`verification_status` is not changed by this seed; every entry stays `pending-verification`.

The offline rule over-seeds relative to the plan ("in a run whose gates passed"). The `Verify Deploy Live` column below is copied
from the GitHub Actions API (`--deploy-runs`), not derived offline, and the exclusions were added by hand from that evidence.

Excluded with `--exclude-sha` (reason: deploy gate failed):
- f3983324e2267ac9a0aaac326cafb4abfd4990ec (best-overlanding-packing-list-complete-guide.html): failure (run 36446263634), open issue #21
- 792513ccbec0383dc5035a5098be62b46adf85e6 (best-overlanding-tool-kits-and-recovery-bags.html): failure (run 35623512965), open issue #19

## Seeded ASINs (10)

| ASIN | Product | Article | Commit SHA | Commit date (UTC) | Verify Deploy Live | Local image | Other qualifying commits |
| --- | --- | --- | --- | --- | --- | --- | --- |
| B00004VXNI | Uniden PRO520XL CB Radio | articles/best-overlanding-cb-radios-and-communication.html | c018959bbae8d97a271053b5c104e94128eb134e | 2026-10-19 | success (run 39321357200) | yes | - |
| B07FN2FBML | Midland MXT275 MicroMobile GMRS Radio | articles/best-overlanding-cb-radios-and-communication.html | c018959bbae8d97a271053b5c104e94128eb134e | 2026-10-19 | success (run 39321357200) | yes | - |
| B07S5GK8NL | Garmin GPSMAP 66i | articles/best-overlanding-cb-radios-and-communication.html | c018959bbae8d97a271053b5c104e94128eb134e | 2026-10-19 | success (run 39321357200) | yes | - |
| B09PF9KCKH | Midland MXT575 MicroMobile GMRS Radio | articles/best-overlanding-cb-radios-and-communication.html | c018959bbae8d97a271053b5c104e94128eb134e | 2026-10-19 | success (run 39321357200) | yes | - |
| B09PSKG7C3 | Garmin inReach Mini 2 Satellite Communicator | articles/best-overlanding-cb-radios-and-communication.html | c018959bbae8d97a271053b5c104e94128eb134e | 2026-10-19 | success (run 39321357200) | yes | - |
| B07PKDRD8Q | OVS HD Nomadic 3 Extended RTT | articles/best-overlanding-ground-tents-vs-rooftop-tents.html | 179a32f3cc884863d437540efa938afe58d42a71 | 2026-10-18 | success (run 39083640258) | yes | - |
| B0BTBHQF8R | Tuff Stuff Alpha Series 55 RTT | articles/best-overlanding-ground-tents-vs-rooftop-tents.html | 179a32f3cc884863d437540efa938afe58d42a71 | 2026-10-18 | success (run 39083640258) | yes | - |
| B0C6JYK3K1 | Sanhima Hotham Hard Shell Rooftop Tent | articles/best-overlanding-ground-tents-vs-rooftop-tents.html | 179a32f3cc884863d437540efa938afe58d42a71 | 2026-10-18 | success (run 39083640258) | yes | - |
| B0DNZ1GDX6 | Naturnest Sirius 1 Hardshell Rooftop Tent | articles/best-overlanding-ground-tents-vs-rooftop-tents.html | 179a32f3cc884863d437540efa938afe58d42a71 | 2026-10-18 | success (run 39083640258) | yes | - |
| B0DT9W7CYY | Big Agnes Copper Spur HV UL2 | articles/best-overlanding-ground-tents-vs-rooftop-tents.html | 179a32f3cc884863d437540efa938afe58d42a71 | 2026-10-18 | success (run 39083640258) | yes | - |

## Auto-publish commits inside the window (5; 15 more fall outside it)

| Commit SHA | Author date (UTC) | Subject | Verify Deploy Live | Decision |
| --- | --- | --- | --- | --- |
| c018959bbae8d97a271053b5c104e94128eb134e | 2026-10-19 | chore: auto-publish best-overlanding-cb-radios-and-communication.html on 2026-10-19 | success (run 39321357200) | qualifies: 5 pool ASIN(s) still on the page at HEAD |
| 179a32f3cc884863d437540efa938afe58d42a71 | 2026-10-18 | chore: auto-publish best-overlanding-ground-tents-vs-rooftop-tents.html on 2026-10-18 | success (run 39083640258) | qualifies: 5 pool ASIN(s) still on the page at HEAD |
| f3983324e2267ac9a0aaac326cafb4abfd4990ec | 2026-09-28 | chore: auto-publish best-overlanding-packing-list-complete-guide.html on 2026-09-28 | failure (run 36446263634), open issue #21 | excluded by --exclude-sha (deploy gate failed) |
| 792513ccbec0383dc5035a5098be62b46adf85e6 | 2026-09-21 | chore: auto-publish best-overlanding-tool-kits-and-recovery-bags.html on 2026-09-21 | failure (run 35623512965), open issue #19 | excluded by --exclude-sha (deploy gate failed) |
| 4e285ee73af6089fd3c6aea6856828b6a3045967 | 2026-09-14 | chore: auto-publish best-overlanding-suspension-upgrades.html on 2026-09-14 | success (run 34873213048) | skipped: commit does not add best-overlanding-suspension-upgrades.html (the article was added by another commit) |
