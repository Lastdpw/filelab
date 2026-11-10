"""Four-class nearest-neighbor model for document orientation."""

from pathlib import Path

import numpy as np
from PIL import Image


ANGLES = (0, 90, 180, 270)  # clockwise orientation relative to upright
MODEL_PATH = Path(__file__).with_name("orientation_model.npz")


def rotate(image: Image.Image, clockwise: int) -> Image.Image:
    operations = {
        90: Image.Transpose.ROTATE_270,
        180: Image.Transpose.ROTATE_180,
        270: Image.Transpose.ROTATE_90,
    }
    return image.transpose(operations[clockwise % 360]) if clockwise % 360 else image


def features(image: Image.Image) -> np.ndarray:
    gray = image.convert("L").resize((144, 144), Image.Resampling.BILINEAR)
    pixels = np.asarray(gray, dtype=np.float32) / 255
    paper = np.percentile(pixels, 90)
    ink = np.clip((paper - pixels) * 2, 0, 1)
    cells = ink.reshape(12, 12, 12, 12).mean(axis=(1, 3))
    row_profile = cells.mean(axis=1)
    column_profile = cells.mean(axis=0)
    horizontal = np.abs(np.diff(ink, axis=1)).mean()
    vertical = np.abs(np.diff(ink, axis=0)).mean()
    aspect = np.clip(np.log(image.width / image.height), -1, 1)
    return np.concatenate((cells.ravel(), 2 * row_profile, 2 * column_profile,
                           [4 * horizontal, 4 * vertical, 0.18 * aspect])).astype(np.float32)


class OrientationModel:
    def __init__(self, samples: np.ndarray, labels: np.ndarray):
        self.samples = samples
        self.labels = labels

    @classmethod
    def load(cls, path: Path = MODEL_PATH):
        with np.load(path, allow_pickle=False) as data:
            return cls(data["samples"], data["labels"])

    def predict(self, image: Image.Image) -> tuple[int, float]:
        sample = features(image)
        distances = ((self.samples - sample) ** 2).mean(axis=1)
        nearest = np.argsort(distances)[:9]
        weights = 1 / (distances[nearest] + 0.000001)
        votes = np.bincount(self.labels[nearest], weights=weights, minlength=4)
        winner = int(votes.argmax())
        return ANGLES[winner], float(votes[winner] / votes.sum())
