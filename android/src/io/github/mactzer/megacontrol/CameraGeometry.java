package io.github.mactzer.megacontrol;

/**
 * TextureView already applies sensor orientation. Compensate display rotation and scale uniformly.
 */
final class CameraGeometry {
  static float[] textureTransform(int vw, int vh, int bw, int bh, int sensor, int display) {
    if (vw <= 0 || vh <= 0 || bw <= 0 || bh <= 0)
      throw new IllegalArgumentException("Dimensiones de cámara inválidas");
    boolean sensorSwaps = sensor % 180 != 0;
    float uprightWidth = sensorSwaps ? bh : bw, uprightHeight = sensorSwaps ? bw : bh;
    boolean displaySwaps = display % 180 != 0;
    float rotatedWidth = displaySwaps ? uprightHeight : uprightWidth;
    float rotatedHeight = displaySwaps ? uprightWidth : uprightHeight;
    float scale = Math.max(vw / rotatedWidth, vh / rotatedHeight);
    float dx = vw / uprightWidth, dy = vh / uprightHeight;
    int angle = ((display % 360) + 360) % 360;
    float cos = angle == 0 ? 1 : angle == 180 ? -1 : 0;
    float sin = angle == 90 ? -1 : angle == 270 ? 1 : 0;
    float a = scale * cos / dx, b = -scale * sin / dy;
    float c = scale * sin / dx, d = scale * cos / dy;
    return new float[] {
      a, b, vw / 2f - a * vw / 2f - b * vh / 2f, c, d, vh / 2f - c * vw / 2f - d * vh / 2f, 0, 0, 1
    };
  }
}
