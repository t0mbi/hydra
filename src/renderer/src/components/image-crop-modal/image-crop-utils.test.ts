import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  computeCenteredCoverCrop,
  fitImageWithinBounds,
} from "./image-crop-utils.js";

describe("fitImageWithinBounds", () => {
  it("preserves wide logo proportions", () => {
    assert.deepEqual(
      fitImageWithinBounds(
        { width: 1000, height: 200 },
        { width: 640, height: 360 }
      ),
      { width: 640, height: 128 }
    );
  });

  it("preserves portrait logo proportions", () => {
    assert.deepEqual(
      fitImageWithinBounds(
        { width: 300, height: 900 },
        { width: 640, height: 360 }
      ),
      { width: 120, height: 360 }
    );
  });

  it("uses the full bounds for matching proportions", () => {
    assert.deepEqual(
      fitImageWithinBounds(
        { width: 1600, height: 900 },
        { width: 640, height: 360 }
      ),
      { width: 640, height: 360 }
    );
  });

  it("recalculates dimensions for rotated logos", () => {
    assert.deepEqual(
      fitImageWithinBounds(
        { width: 200, height: 1000 },
        { width: 640, height: 360 }
      ),
      { width: 72, height: 360 }
    );
  });
});

describe("computeCenteredCoverCrop", () => {
  it("crops the sides of a square source to cover a portrait grid", () => {
    const { region, outputSize } = computeCenteredCoverCrop(
      { width: 1000, height: 1000 },
      { width: 600, height: 900 }
    );

    assert.deepEqual(outputSize, { width: 600, height: 900 });
    assert.deepEqual(region, {
      left: 500 / 3,
      top: 0,
      width: 2000 / 3,
      height: 1000,
    });
  });

  it("returns the full output bounds when source and output share proportions", () => {
    const { region, outputSize } = computeCenteredCoverCrop(
      { width: 1200, height: 800 },
      { width: 600, height: 400 }
    );

    assert.deepEqual(outputSize, { width: 600, height: 400 });
    assert.deepEqual(region, { left: 0, top: 0, width: 1200, height: 800 });
  });

  it("does not crop when preserving source aspect ratio (logos)", () => {
    const { region, outputSize } = computeCenteredCoverCrop(
      { width: 1200, height: 800 },
      { width: 640, height: 360 },
      true
    );

    assert.deepEqual(outputSize, { width: 540, height: 360 });
    assert.deepEqual(region, { left: 0, top: 0, width: 1200, height: 800 });
  });
});
