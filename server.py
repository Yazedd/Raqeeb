"""Serve Raqeeb and analyze the videos in examples/ and samples/ as cameras."""

import argparse
from pathlib import Path
from video_cameras import serve_video_cameras

ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--videos", help="video directory; defaults to examples/ and samples/")
    parser.add_argument("--model", default=str(ROOT / "yolo26n.pt"))
    parser.add_argument("--weapon-model", "--weapon_model", dest="weapon_model", default=str(ROOT / "weapon.pt"))
    parser.add_argument("--pose-model", dest="pose_model", default=str(ROOT / "yolo26n-pose.pt"))
    parser.add_argument("--runtime-dir", help="alternate directory for analysis, evidence, and incidents")
    parser.add_argument("--tracker", default=str(ROOT / "person_tracker.yaml"), help="Ultralytics tracker configuration")
    parser.add_argument("--imgsz", type=int, default=1280, help="person detection resolution (default: 1280)")
    parser.add_argument("--analysis-fps", type=float, default=12, help="weapon samples per source second (default: 12)")
    parser.add_argument("--weapon-conf", type=float, default=0.35, help="minimum weapon candidate score; lower-score candidates require repeated evidence (default: 0.35)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    serve_video_cameras(parser.parse_args())


if __name__ == "__main__":
    main()
