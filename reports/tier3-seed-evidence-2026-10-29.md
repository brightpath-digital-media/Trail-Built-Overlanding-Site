# Tier 3 seed evidence

As-of date: 2026-10-29. Window: 45 days (author date, UTC, inclusive). Main ref: origin/main.
Produced by `scripts/seed-verified-from-history.mjs`. Audit any row with `git show --stat <SHA>` and `git log -1 --format=%aI <SHA>`.

Limitation: the later `Verify Deploy Live` conclusion of each run cannot be read offline. Evidence that the run passed
is limited to: a normal `chore: auto-publish` commit that is on main, whose article is still present at HEAD with the ASIN still on the page.
`verification_status` is not changed by this seed; every entry stays `pending-verification`.

## Seeded ASINs (22)

| ASIN | Product | Article | Commit SHA | Commit date (UTC) | Local image | Other qualifying commits |
| --- | --- | --- | --- | --- | --- | --- |
| B00004VXNI | Uniden PRO520XL CB Radio | articles/best-overlanding-cb-radios-and-communication.html | c018959bbae8d97a271053b5c104e94128eb134e | 2026-10-19 | yes | - |
| B07FN2FBML | Midland MXT275 MicroMobile GMRS Radio | articles/best-overlanding-cb-radios-and-communication.html | c018959bbae8d97a271053b5c104e94128eb134e | 2026-10-19 | yes | - |
| B07S5GK8NL | Garmin GPSMAP 66i | articles/best-overlanding-cb-radios-and-communication.html | c018959bbae8d97a271053b5c104e94128eb134e | 2026-10-19 | yes | - |
| B09PF9KCKH | Midland MXT575 MicroMobile GMRS Radio | articles/best-overlanding-cb-radios-and-communication.html | c018959bbae8d97a271053b5c104e94128eb134e | 2026-10-19 | yes | - |
| B09PSKG7C3 | Garmin inReach Mini 2 Satellite Communicator | articles/best-overlanding-cb-radios-and-communication.html | c018959bbae8d97a271053b5c104e94128eb134e | 2026-10-19 | yes | - |
| B07PKDRD8Q | OVS HD Nomadic 3 Extended RTT | articles/best-overlanding-ground-tents-vs-rooftop-tents.html | 179a32f3cc884863d437540efa938afe58d42a71 | 2026-10-18 | yes | - |
| B0BTBHQF8R | Tuff Stuff Alpha Series 55 RTT | articles/best-overlanding-ground-tents-vs-rooftop-tents.html | 179a32f3cc884863d437540efa938afe58d42a71 | 2026-10-18 | yes | - |
| B0C6JYK3K1 | Sanhima Hotham Hard Shell Rooftop Tent | articles/best-overlanding-ground-tents-vs-rooftop-tents.html | 179a32f3cc884863d437540efa938afe58d42a71 | 2026-10-18 | yes | - |
| B0DNZ1GDX6 | Naturnest Sirius 1 Hardshell Rooftop Tent | articles/best-overlanding-ground-tents-vs-rooftop-tents.html | 179a32f3cc884863d437540efa938afe58d42a71 | 2026-10-18 | yes | - |
| B0DT9W7CYY | Big Agnes Copper Spur HV UL2 | articles/best-overlanding-ground-tents-vs-rooftop-tents.html | 179a32f3cc884863d437540efa938afe58d42a71 | 2026-10-18 | yes | - |
| B004P9C5H8 | ARB ARB710LB 30-foot Recovery Snatch Strap | articles/best-overlanding-packing-list-complete-guide.html | f3983324e2267ac9a0aaac326cafb4abfd4990ec | 2026-09-28 | yes | - |
| B006ERS6OU | GSI Outdoors Pinnacle Camper Cookset | articles/best-overlanding-packing-list-complete-guide.html | f3983324e2267ac9a0aaac326cafb4abfd4990ec | 2026-09-28 | yes | - |
| B015OL55VS | Leatherman Signal Multi-Tool | articles/best-overlanding-packing-list-complete-guide.html | f3983324e2267ac9a0aaac326cafb4abfd4990ec | 2026-09-28 | yes | - |
| B07TJ35L3V | ICECO GO20 Dual Zone Portable Refrigerator | articles/best-overlanding-packing-list-complete-guide.html | f3983324e2267ac9a0aaac326cafb4abfd4990ec | 2026-09-28 | yes | - |
| B0CKKBZH85 | Adventure Medical Kits Mountain Series Hiker | articles/best-overlanding-packing-list-complete-guide.html | f3983324e2267ac9a0aaac326cafb4abfd4990ec | 2026-09-28 | yes | - |
| B0D7PPG25F | Jackery Explorer 1000 v2 Portable Power Station | articles/best-overlanding-packing-list-complete-guide.html | f3983324e2267ac9a0aaac326cafb4abfd4990ec | 2026-09-28 | yes | - |
| B00042KG3A | Hi-Lift Jack 48 HL-484 | articles/best-overlanding-tool-kits-and-recovery-bags.html | 792513ccbec0383dc5035a5098be62b46adf85e6 | 2026-09-21 | yes | - |
| B00042KQ58 | Hi-Lift Jack Off-Road Kit | articles/best-overlanding-tool-kits-and-recovery-bags.html | 792513ccbec0383dc5035a5098be62b46adf85e6 | 2026-09-21 | yes | - |
| B000WZCSTO | Gerber Gorge Folding Shovel | articles/best-overlanding-tool-kits-and-recovery-bags.html | 792513ccbec0383dc5035a5098be62b46adf85e6 | 2026-09-21 | yes | - |
| B0017T7WGS | Hi-Lift Jack 42-inch All-Cast Jack HL-425 | articles/best-overlanding-tool-kits-and-recovery-bags.html | 792513ccbec0383dc5035a5098be62b46adf85e6 | 2026-09-21 | yes | - |
| B001DZX7C4 | SOG Power Assist Multi-Plier | articles/best-overlanding-tool-kits-and-recovery-bags.html | 792513ccbec0383dc5035a5098be62b46adf85e6 | 2026-09-21 | yes | - |
| B004M3BAQE | Fiskars X27 Super Splitting Axe | articles/best-overlanding-tool-kits-and-recovery-bags.html | 792513ccbec0383dc5035a5098be62b46adf85e6 | 2026-09-21 | yes | - |

## Auto-publish commits inside the window (5; 15 more fall outside it)

| Commit SHA | Author date (UTC) | Subject | Decision |
| --- | --- | --- | --- |
| c018959bbae8d97a271053b5c104e94128eb134e | 2026-10-19 | chore: auto-publish best-overlanding-cb-radios-and-communication.html on 2026-10-19 | qualifies: 5 pool ASIN(s) still on the page at HEAD |
| 179a32f3cc884863d437540efa938afe58d42a71 | 2026-10-18 | chore: auto-publish best-overlanding-ground-tents-vs-rooftop-tents.html on 2026-10-18 | qualifies: 5 pool ASIN(s) still on the page at HEAD |
| f3983324e2267ac9a0aaac326cafb4abfd4990ec | 2026-09-28 | chore: auto-publish best-overlanding-packing-list-complete-guide.html on 2026-09-28 | qualifies: 6 pool ASIN(s) still on the page at HEAD |
| 792513ccbec0383dc5035a5098be62b46adf85e6 | 2026-09-21 | chore: auto-publish best-overlanding-tool-kits-and-recovery-bags.html on 2026-09-21 | qualifies: 6 pool ASIN(s) still on the page at HEAD |
| 4e285ee73af6089fd3c6aea6856828b6a3045967 | 2026-09-14 | chore: auto-publish best-overlanding-suspension-upgrades.html on 2026-09-14 | skipped: commit does not add best-overlanding-suspension-upgrades.html (the article was added by another commit) |
