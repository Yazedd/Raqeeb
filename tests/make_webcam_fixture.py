"""Generate an explicit browser-test camera input from supplied footage, never used by the app."""
import argparse
from pathlib import Path


def main():
    import cv2
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output",default="runtime/webcam-test.y4m")
    args=parser.parse_args()
    source=Path(__file__).resolve().parents[1]/"samples"/"example.mp4"
    capture=cv2.VideoCapture(str(source));frames=[]
    # Clear weapon views are used for this transport/inference regression.
    # The first small-gun appearance is sensitive to webcam chroma subsampling.
    for seconds in [17.4174,17.5175]:
        capture.set(cv2.CAP_PROP_POS_MSEC,seconds*1000)
        ok,image=capture.read()
        if not ok:raise RuntimeError("Could not read webcam test source")
        height,width=image.shape[:2]
        frames.append(cv2.cvtColor(image,cv2.COLOR_BGR2YUV_I420).tobytes())
    capture.release()
    output=Path(args.output);output.parent.mkdir(parents=True,exist_ok=True)
    with output.open("wb") as target:
        target.write(f"YUV4MPEG2 W{width} H{height} F10:1 Ip A1:1 C420\n".encode())
        for index in range(100):target.write(b"FRAME\n"+frames[(index//10)%2])
    print(f"Browser-test-only camera fixture: {output.resolve()}")


if __name__=="__main__":main()
