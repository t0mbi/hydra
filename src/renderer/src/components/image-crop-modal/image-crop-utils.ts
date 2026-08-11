export interface ImageDimensions {
  width: number;
  height: number;
}

export const fitImageWithinBounds = (
  source: ImageDimensions,
  bounds: ImageDimensions
): ImageDimensions => {
  if (
    source.width <= 0 ||
    source.height <= 0 ||
    bounds.width <= 0 ||
    bounds.height <= 0
  ) {
    return bounds;
  }

  const sourceAspectRatio = source.width / source.height;
  const boundsAspectRatio = bounds.width / bounds.height;

  if (sourceAspectRatio >= boundsAspectRatio) {
    return {
      width: bounds.width,
      height: Math.max(1, Math.round(bounds.width / sourceAspectRatio)),
    };
  }

  return {
    width: Math.max(1, Math.round(bounds.height * sourceAspectRatio)),
    height: bounds.height,
  };
};

export interface CropRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CenteredCoverCrop {
  region: CropRegion;
  outputSize: ImageDimensions;
}

/**
 * Computes the same crop rectangle ImageCropModal starts with by default
 * (centered, no zoom/pan/rotation) without needing the modal mounted: a
 * "cover" fit against the output box, or (when preserveSourceAspectRatio is
 * set, as for logos) a plain fit-to-bounds with no cropping at all.
 */
export const computeCenteredCoverCrop = (
  source: ImageDimensions,
  output: ImageDimensions,
  preserveSourceAspectRatio = false
): CenteredCoverCrop => {
  const outputSize = preserveSourceAspectRatio
    ? fitImageWithinBounds(source, output)
    : output;

  if (source.width <= 0 || source.height <= 0) {
    return {
      region: { left: 0, top: 0, width: source.width, height: source.height },
      outputSize,
    };
  }

  const frame = preserveSourceAspectRatio ? source : outputSize;
  const scale = Math.max(
    frame.width / source.width,
    frame.height / source.height
  );
  const positionX = (frame.width - source.width * scale) / 2;
  const positionY = (frame.height - source.height * scale) / 2;

  return {
    region: {
      // `+ 0` normalizes -0 (e.g. when positionX/Y is exactly 0) to 0.
      left: -positionX / scale + 0,
      top: -positionY / scale + 0,
      width: frame.width / scale,
      height: frame.height / scale,
    },
    outputSize,
  };
};
