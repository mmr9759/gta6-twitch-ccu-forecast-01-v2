[![make.fun](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/mmr9759/gta6-twitch-ccu-forecast-01/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/mmr9759/gta6-twitch-ccu-forecast-01/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01)

# GTA VI launch-day Twitch viewers — hourly forecast (v2)

Forecast how many people watch Grand Theft Auto VI live on Twitch in each
hour of its release day, 2026-11-19 (UTC), after the first hour. The entry
program (`main.ts`, Node 22, standard library only) reads a case file from
the input directory and writes five quantiles (0.05, 0.25, 0.5, 0.75, 0.95)
of each hour's concurrent-viewer count, hours 2 to 24, to the output
directory.

## Method (v2)

A launch's Twitch audience follows the rolling midnight unlock, and how
far it climbs depends strongly on how big hour 1 already is. This version
improves on v1 in two measured ways. First, it trusts the comparables
unequally: the kit's own notes mark some as early-access-contaminated and
some as weak, so those count half and a quarter respectively, while clean
rolling-midnight launches count fully. Second, it blends two views of the
size effect — a kernel-weighted median of the comparable log-ratios and a
weighted line of log-ratio on log hour-1 — averaged in log space, so the
forecast uses both the local median and the global size trend.

Validated offline by leave-one-out over the 37 usable comparables: mean
pinball loss 0.39 overall, 0.18 on launches with hour-1 >= 50,000 and
0.13 on launches with hour-1 >= 300,000, against 0.40 / 0.21 / 0.14 for
the v1 kernel alone on the same sets.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```
