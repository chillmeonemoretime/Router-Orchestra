# Router Orchestra

[English](README.md) | 简体中文

**Listen to your Internet. 听见你的互联网。**

Router Orchestra 把路由器的实时 WAN 流量变成音乐。浏览网页、看视频、下载文件或跑一次测速，乐队都会跟着变化：节奏更快、编排更密、声音更饱满。网络安静下来时，音乐也会随之安静。

它读取的是路由器的**硬件**计数器，因此可以在开启硬件 NAT / 硬件流量卸载的情况下正常工作，无需在路由器上安装任何软件，也不修改任何配置。

## 演示视频

<table>
  <tr>
    <td align="center" width="50%">
      <a href="https://youtu.be/gyaIcjEzBLc"><img src="https://img.youtube.com/vi/gyaIcjEzBLc/maxresdefault.jpg" alt="▶ 真实路由器流量"></a><br>
      <sub>▶ 真实路由器流量</sub>
    </td>
    <td align="center" width="50%">
      <a href="https://youtu.be/-BmgDCMcq7k"><img src="https://img.youtube.com/vi/-BmgDCMcq7k/maxresdefault.jpg" alt="▶ Demo 模式（模拟流量）"></a><br>
      <sub>▶ Demo 模式（模拟流量）</sub>
    </td>
  </tr>
</table>

## 快速开始

```
python3 orchestra.py --host 192.168.2.1 --user root --interface wan
# 打开 http://127.0.0.1:8765 并点击 Start
```

手边没有路由器？运行 `python3 orchestra.py --demo` 即可。

## 工作原理

```
OpenWrt 路由器 ──（一个持久 SSH 会话：每秒执行一次 `ethtool -S wan`）──▶
  orchestra.py（Python 标准库：计数器 → Mbps / PPS）──（Server-Sent Events）──▶
    浏览器（Web Audio 合成器 · 实时波形 · 节拍动效 · 播放控制）
```

1. `orchestra.py` 只建立**一个** SSH 连接，并在路由器上运行一个小小的 shell 循环。每个采样间隔输出一行数据，包含 `/proc/uptime`，以及从 `ethtool -S <iface>` 读到的四个累计计数器：`rx_bytes`、`tx_bytes`、`rx_packets`、`tx_packets`。
2. 速率由相邻两次采样的差值，除以路由器自身记录的实际经过时间得出，因此即使采样间隔不规则，结果依然准确：
   `Mbps = Δbytes × 8 / Δt / 10⁶`，`PPS = Δpackets / Δt`。
3. 浏览器通过 SSE 接收速率数据，在对数刻度上做平滑（EMA，α = 0.3），再交给运行在固定十六分音符时钟上的生成式音乐引擎。

### 流量 → 音乐

| 网络指标      | 音乐元素                                     |
| ------------- | -------------------------------------------- |
| Download Mbps | 速度（60–160 BPM）与旋律密度                 |
| Upload Mbps   | 贝斯：从全音符，到四分音符，再到推进感的八分音符 |
| RX PPS        | 底鼓与军鼓的密度                             |
| TX PPS        | 踩镲：反拍，然后八分音符，再到十六分音符     |
| 空闲          | 柔和的环境铺底（Pad）与偶尔出现的风铃音      |

所有声音始终保持在调内。和弦进行为 Am7 → Fmaj7 → Cadd9 → Gsus2，旋律使用 A 小调五声音阶，由两小节的动机构成，每个动机重复一遍后才变化。数据包从不直接触发音符：流量只负责调整“目标值”，由音乐时钟决定演奏什么。输出依次经过压缩器和限幅器，默认音量为 30%。

## 硬件 NAT 兼容性

在 MT7621 等 SoC 上，被卸载的连接会绕过 Linux 网络协议栈。因此常用的 `/sys/class/net/*/statistics` 计数器和 conntrack 字节统计都会漏掉大部分流量；MT7621 的 PPE 逐连接计数器也无法使用。

`ethtool -S` 读取的则是**交换机端口的 MIB 计数器**：每一个经过 WAN 口的帧都由硬件计数，无论是否被卸载。实际效果是：

- 硬件 NAT / 流量卸载**保持开启**。
- 不抓包、不做 DPI，也不在转发路径中插入任何东西。
- 不修改路由器配置，不安装额外软件包。远端循环只用到 `sh`、`awk` 和 `ethtool`，SSH 会话结束后会自行退出。
- 开销只是每秒一次 `ethtool` 调用。想自己确认的话，可以分别在停止和运行 Router Orchestra 时各跑一次测速，两次结果应当一致。

已在 Phicomm K2P（MT7621）、ImmortalWrt 24.10、内核 6.6、开启硬件流量卸载的环境中验证。

## 环境要求

- **客户端：** Python 3.9+ 和系统自带的 OpenSSH 客户端（macOS 与 Linux 均已内置），无需任何 pip 依赖。
- **路由器：** OpenWrt 或其衍生系统，需要有 `ethtool`（ImmortalWrt 已自带），并可通过 SSH 访问。
- **认证：** 使用 SSH 密钥或 ssh-agent。Router Orchestra 以 `BatchMode=yes` 运行 `ssh`，因此不会提示输入密码，也不会存储密码；同时绝不绕过主机密钥校验。请先手动连接一次（`ssh root@192.168.2.1`）以接受主机密钥。

如需使用其他 SSH 端口或密钥，可在 `~/.ssh/config` 中添加条目，并把别名传给 `--host`：

```
Host k2p
    HostName 192.168.2.1
    User root
    Port 22
    IdentityFile ~/.ssh/id_ed25519
```

## 使用方法

```
python3 orchestra.py --host HOST [--user root] [--interface wan] [--interval 1] [--port 8765] [--bind 127.0.0.1]
python3 orchestra.py --demo
```

| 参数          | 默认值      | 说明                                                             |
| ------------- | ----------- | ---------------------------------------------------------------- |
| `--host`      | —           | 路由器地址或 `~/.ssh/config` 别名（未使用 `--demo` 时必填）      |
| `--user`      | `root`      | SSH 用户名                                                       |
| `--interface` | `wan`       | 传给 `ethtool -S` 的接口名                                       |
| `--interval`  | `1`         | 采样间隔，单位秒（0.2–10）                                       |
| `--port`      | `8765`      | HTTP 端口                                                        |
| `--bind`      | `127.0.0.1` | HTTP 监听地址；默认仅监听本机                                    |
| `--demo`      | 关闭        | 模拟流量，依次循环：空闲、浏览网页、视频、下载、上传、测速       |

打开 `http://127.0.0.1:8765` 并点击 **Start**。浏览器只允许在用户点击之后播放声音。

### 容错机制

- 任何一次（重新）连接后的首个采样只用于初始化计数器，因此重连永远不会变成一阵突兀的爆音。
- 当计数器回退（接口重置或路由器重启），或两次采样间隔过长时，计算器会重新初始化，而不是输出一个错误的速率。
- SSH 断开后按退避策略自动重连（从 2 秒开始翻倍，最长 30 秒）；会话连续 10 秒没有数据时会被重启。
- 数据停止更新时，音乐逐渐淡出至静音；收到新的采样后再逐渐恢复。

### 常见问题

| 状态信息                                        | 解决方法                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------- |
| `Host key verification failed.`                 | 先运行一次 `ssh root@<路由器>` 并接受主机密钥。                              |
| `Permission denied (publickey…)`                | 把你的公钥添加到路由器（LuCI → 系统 → 管理权 → SSH 密钥）。                  |
| `ethtool -S wan did not report rx/tx counters`  | 在路由器上检查 `ethtool -S <iface>` 的输出，并传入正确的 `--interface`。     |
| `Cannot listen on 127.0.0.1:8765`               | 端口已被占用（例如 Anki 的 AnkiConnect 插件也使用 8765），换一个端口：`--port 8766`。 |

## 项目结构

```
orchestra.py          CLI、SSH 采集、Demo 流量生成、速率计算、HTTP + SSE 服务
static/index.html     页面
static/style.css      深色界面样式
static/app.js         SSE 客户端、指标显示、60 秒波形、节拍动效
static/audio.js       Web Audio 音乐引擎
tests/test_metrics.py 解析、速率计算、重置处理、Demo 合理性测试
```

运行测试：

```
python3 -m unittest discover -s tests -v
```

## 暂不包含

按设备或按连接的流量统计、conntrack、抓包、历史数据存储、用户认证、远程面板、路由器端守护进程、多种音乐风格。

## 许可证

[Mozilla Public License 2.0](LICENSE)
