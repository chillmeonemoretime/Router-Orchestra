import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from orchestra import (  # noqa: E402
    DemoCollector,
    Hub,
    RateCalculator,
    Sample,
    parse_args,
    parse_sample,
    remote_script,
)


def sample(t, rx_b=0, tx_b=0, rx_p=0, tx_p=0):
    return Sample(t, rx_b, tx_b, rx_p, tx_p)


class ParseSampleTest(unittest.TestCase):
    def test_valid_line(self):
        self.assertEqual(
            parse_sample("RO 12345.67 1000 2000 30 40\n"),
            Sample(12345.67, 1000, 2000, 30, 40),
        )

    def test_large_counters(self):
        s = parse_sample("RO 1.00 98765432109876 1 2 3")
        self.assertEqual(s.rx_bytes, 98765432109876)

    def test_rejects_garbage(self):
        for line in [
            "",
            "hello",
            "RO 1.0",                          # ethtool missing counters
            "RO 1.0 1 2 3",
            "RO 1.0 1 2 3 x",
            "XX 1.0 1 2 3 4",
            "RO 1.0 -1 2 3 4",
            "RO 1.0 1 2 3 4 5",
            "RO 1.0 1.5e6 2 3 4",              # awk numeric formatting must not sneak in
        ]:
            with self.subTest(line=line):
                self.assertIsNone(parse_sample(line))


class RateCalculatorTest(unittest.TestCase):
    def test_first_sample_only_initialises(self):
        self.assertIsNone(RateCalculator().update(sample(100, 10**9, 10**9, 10**6, 10**6)))

    def test_rates(self):
        calc = RateCalculator()
        calc.update(sample(100.0, 0, 0, 0, 0))
        r = calc.update(sample(101.0, 12_500_000, 1_250_000, 9000, 4000))
        self.assertAlmostEqual(r.down_mbps, 100.0)
        self.assertAlmostEqual(r.up_mbps, 10.0)
        self.assertAlmostEqual(r.rx_pps, 9000)
        self.assertAlmostEqual(r.tx_pps, 4000)
        self.assertAlmostEqual(r.dt, 1.0)

    def test_irregular_interval_uses_real_elapsed_time(self):
        calc = RateCalculator()
        calc.update(sample(100.0))
        r = calc.update(sample(101.5, 1_875_000, 0, 300, 0))
        self.assertAlmostEqual(r.down_mbps, 10.0)
        self.assertAlmostEqual(r.rx_pps, 200)
        r = calc.update(sample(101.75, 1_875_000 + 312_500, 0, 350, 0))
        self.assertAlmostEqual(r.down_mbps, 10.0)
        self.assertAlmostEqual(r.rx_pps, 200)

    def test_counter_reset_reinitialises(self):
        calc = RateCalculator()
        calc.update(sample(100, 5_000_000, 5_000_000, 5000, 5000))
        self.assertIsNone(calc.update(sample(101, 100, 5_000_100, 1, 5001)))
        # Next sample is measured from the post-reset baseline.
        r = calc.update(sample(102, 125_100, 5_000_100, 11, 5001))
        self.assertAlmostEqual(r.down_mbps, 1.0)
        self.assertAlmostEqual(r.rx_pps, 10)

    def test_clock_going_backwards_reinitialises(self):
        # Router reboot: uptime restarts, counters restart.
        calc = RateCalculator()
        calc.update(sample(5000, 10**9, 10**9, 10**6, 10**6))
        self.assertIsNone(calc.update(sample(3, 10**9 + 1, 10**9 + 1, 10**6 + 1, 10**6 + 1)))

    def test_duplicate_timestamp_is_ignored(self):
        calc = RateCalculator()
        calc.update(sample(100))
        self.assertIsNone(calc.update(sample(100, 1000)))

    def test_long_gap_reinitialises(self):
        calc = RateCalculator(max_gap=10)
        calc.update(sample(100))
        self.assertIsNone(calc.update(sample(160, 10**9)))
        self.assertIsNotNone(calc.update(sample(161, 10**9 + 1)))

    def test_reset(self):
        calc = RateCalculator()
        calc.update(sample(100))
        calc.reset()
        self.assertIsNone(calc.update(sample(101, 10**9)))


class RemoteScriptTest(unittest.TestCase):
    def test_script_shape(self):
        script = remote_script("wan", 1.0)
        self.assertIn("ethtool -S wan", script)
        self.assertIn("/proc/uptime", script)
        self.assertIn("sleep 1;", script)
        self.assertIn("|| exit 1", script)

    def test_interval_formatting(self):
        self.assertIn("sleep 0.5;", remote_script("wan", 0.5))

    def test_invalid_interface_rejected(self):
        with self.assertRaises(SystemExit):
            parse_args(["--host", "r", "--interface", "wan; reboot"])

    def test_host_required_without_demo(self):
        with self.assertRaises(SystemExit):
            parse_args([])
        self.assertTrue(parse_args(["--demo"]).demo)


class DemoCollectorTest(unittest.TestCase):
    def test_demo_produces_sane_metrics(self):
        hub = Hub({"mode": "demo"}, history_len=10)
        stop = threading.Event()
        collector = DemoCollector(hub, interval=0.05, seed=1)
        t = threading.Thread(target=collector.run, args=(stop,))
        t.start()
        threading.Event().wait(0.4)
        stop.set()
        t.join(2)
        _, status, history = hub.subscribe()
        self.assertEqual(status["state"], "demo")
        self.assertGreater(len(history), 2)
        for m in history:
            for k in ("down", "up", "rx_pps", "tx_pps"):
                self.assertGreaterEqual(m[k], 0)

    def test_scenes_are_distinct(self):
        demo = DemoCollector(Hub({}, 1), interval=1, seed=2)
        idle = max(demo.traffic("Idle", 5)[0] for _ in range(50))
        download = min(demo.traffic("Large download", 10)[0] for _ in range(50))
        upload = min(demo.traffic("Upload", 10)[1] for _ in range(50))
        self.assertLess(idle, 0.1)
        self.assertGreater(download, 100)
        self.assertGreater(upload, 20)


if __name__ == "__main__":
    unittest.main()
