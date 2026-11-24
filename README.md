# Router Orchestra

English | [简体中文](README.zh-CN.md)

**Listen to your Internet.**

Router Orchestra turns your router's live WAN traffic into music. Browse, stream, download or run a speed test and the band follows along: faster, denser, louder. When the network goes quiet, so does the music.

It reads the router's **hardware** counters, so it works with Hardware NAT / flow offloading left on. Nothing gets installed on or changed on the router.

## Demo videos

<table>
  <tr>
    <td align="center" width="50%">
      <a href="https://youtu.be/gyaIcjEzBLc"><img src="https://img.youtube.com/vi/gyaIcjEzBLc/maxresdefault.jpg" alt="▶ Real router traffic"></a><br>
      <sub>▶ Real router traffic</sub>
    </td>
    <td align="center" width="50%">
      <a href="https://youtu.be/-BmgDCMcq7k"><img src="https://img.youtube.com/vi/-BmgDCMcq7k/maxresdefault.jpg" alt="▶ Demo mode (simulated traffic)"></a><br>
      <sub>▶ Demo mode (simulated traffic)</sub>
    </td>
  </tr>
</table>

## Quick start

```
python3 orchestra.py --host 192.168.2.1 --user root --interface wan
# open http://127.0.0.1:8765 and press Start
```

No router handy? `python3 orchestra.py --demo`

## How it works

```
OpenWrt router ──(one persistent SSH session: `ethtool -S wan` every second)──▶
  orchestra.py  (Python stdlib: counters → Mbps / PPS)  ──(Server-Sent Events)──▶
    browser     (Web Audio synth · live waveform · beat visuals · controls)
```

1. `orchestra.py` opens **one** SSH connection and runs a small shell loop on the router. Once per interval the loop prints a line holding `/proc/uptime` and four cumulative counters from `ethtool -S <iface>`: `rx_bytes`, `tx_bytes`, `rx_packets` and `tx_packets`.
2. Rates come from adjacent samples, divided by the router's own elapsed time, so irregular intervals stay accurate:
   `Mbps = Δbytes × 8 / Δt / 10⁶`, `PPS = Δpackets / Δt`.
3. The browser receives the rates over SSE. It smooths them (EMA, α = 0.3) on a log scale and hands them to a generative music engine that runs on a fixed 16th-note clock.

### Traffic → music

| Network metric | Musical element                                         |
| -------------- | ------------------------------------------------------- |
| Download Mbps  | Tempo (60–160 BPM) and melody density                   |
| Upload Mbps    | Bass: from whole notes, to quarters, to driving eighths |
| RX PPS         | Kick and snare density                                  |
| TX PPS         | Hi-hats: offbeats, then eighths, then sixteenths        |
| Idle           | A soft ambient pad and the occasional chime             |

Everything stays in key. The chords run Am7 → Fmaj7 → Cadd9 → Gsus2, and the melody uses A minor pentatonic, built from two-bar motifs that repeat before they change. Packets never trigger notes directly: traffic only moves *targets*, and the clock decides what to play. The output passes through a compressor and a limiter, and volume starts at 30%.

## Hardware NAT compatibility

On MT7621 and similar SoCs, offloaded flows bypass the Linux network stack. The usual `/sys/class/net/*/statistics` counters and conntrack byte counts therefore miss most of your traffic. The PPE's per-flow counters aren't usable on MT7621 either.

`ethtool -S` reads the **switch port's MIB counters** instead. Every frame crossing the WAN port is counted in hardware, offloaded or not. In practice that means:

- Hardware NAT / flow offloading **stays enabled**.
- No packet capture, no DPI, nothing inserted into the forwarding path.
- No router-side config changes and no extra packages. The loop is plain `sh`, `awk` and `ethtool`, and it exits by itself when the SSH session ends.
- The cost is one `ethtool` call per second. To check for yourself, run a speed test with Router Orchestra stopped, then again with it running; the results should match.

Verified on a Phicomm K2P (MT7621) running ImmortalWrt 24.10, kernel 6.6, with hardware flow offloading on.

## Requirements

- **Client:** Python 3.9+ and the system OpenSSH client (macOS and Linux both ship one). No pip packages needed.
- **Router:** OpenWrt or a derivative with `ethtool` available (ImmortalWrt includes it), reachable over SSH.
- **Auth:** an SSH key or agent. Router Orchestra runs `ssh` with `BatchMode=yes`, so it never prompts for or stores a password. It also never bypasses host key checks: connect once by hand (`ssh root@192.168.2.1`) to accept the host key.

To use a different SSH port or key, add an entry to `~/.ssh/config` and pass its alias as `--host`:

```
Host k2p
    HostName 192.168.2.1
    User root
    Port 22
    IdentityFile ~/.ssh/id_ed25519
```

## Usage

```
python3 orchestra.py --host HOST [--user root] [--interface wan] [--interval 1] [--port 8765] [--bind 127.0.0.1]
python3 orchestra.py --demo
```

| Option        | Default     | Meaning                                                          |
| ------------- | ----------- | ---------------------------------------------------------------- |
| `--host`      | —           | Router address or `~/.ssh/config` alias (required unless `--demo`) |
| `--user`      | `root`      | SSH user                                                         |
| `--interface` | `wan`       | Interface passed to `ethtool -S`                                 |
| `--interval`  | `1`         | Sample interval in seconds (0.2–10)                              |
| `--port`      | `8765`      | HTTP port                                                        |
| `--bind`      | `127.0.0.1` | HTTP bind address; localhost only by default                     |
| `--demo`      | off         | Simulated traffic that cycles through idle, browsing, video, download, upload and a speed test |

Open `http://127.0.0.1:8765` and press **Start**. Browsers only allow audio after a click.

### Resilience

- The first sample after any (re)connect only initialises the counters, so a reconnect never plays as a huge burst.
- When a counter goes backwards (interface reset or router reboot), or the gap between samples is too large, the calculator re-initialises instead of reporting a rate.
- SSH drops are retried with backoff (2 s doubling to 30 s). A session that stays silent for 10 s is restarted.
- When data stops arriving, the music fades to silence. It fades back in once fresh samples return.

### Troubleshooting

| Status message                                 | Fix                                                                                          |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `Host key verification failed.`                | Run `ssh root@<router>` once and accept the key.                                             |
| `Permission denied (publickey…)`               | Add your public key to the router (LuCI → System → Administration → SSH-Keys).               |
| `ethtool -S wan did not report rx/tx counters` | Check `ethtool -S <iface>` on the router and pass the right `--interface`.                 |
| `Cannot listen on 127.0.0.1:8765`               | The port is taken (Anki's AnkiConnect add-on also uses 8765). Pick another: `--port 8766`. |

## Project layout

```
orchestra.py          CLI, SSH collector, demo generator, rate maths, HTTP + SSE server
static/index.html     page
static/style.css      dark UI
static/app.js         SSE client, stats, 60-second waveform, beat visuals
static/audio.js       Web Audio music engine
tests/test_metrics.py parsing, rate calculation, reset handling, demo sanity
```

Run the tests with:

```
python3 -m unittest discover -s tests -v
```

## Out of scope (for now)

Per-device or per-connection traffic, conntrack, packet capture, history storage, auth, remote dashboards, router-side daemons, and multiple genres.

## License

[Mozilla Public License 2.0](LICENSE)
