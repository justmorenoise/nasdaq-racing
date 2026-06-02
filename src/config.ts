/**
 * Central tunables. Everything that affects "feel" lives here so it can be
 * tweaked without hunting through modules.
 */
export const CONFIG = {
  /** Daily % change is clamped to this band before mapping to lap time. */
  changePctClamp: 8,

  /**
   * Car speed eases toward its target instead of snapping (the "elastic" feel).
   * Larger = snappier. Units: 1/seconds (exponential smoothing rate).
   */
  speedEaseRate: 0.8,

  /** Lateral offset easing for overtakes (1/seconds). */
  laneEaseRate: 2.5,

  /**
   * Track speed-profile shape (scale-invariant relative units, vMax = top speed).
   * Cornering severity is derived from each track's own curvature distribution,
   * and accel/brake limits are expressed per lap-fraction so the feel is the
   * same on a short kart-like track and a long one.
   */
  profile: {
    vMin: 0.28, // slowest corner as a fraction of top speed
    vMax: 1.0, // straight-line top speed
    accel: 6, // acceleration limit (rel-speed² gained per lap-fraction)
    brake: 13, // braking limit (rel-speed² shed per lap-fraction)
    corneringPercentile: 0.9, // curvature percentile that maps to vMin
    smoothing: 2, // curvature smoothing window (samples each side)
  },

  /** Battle detection. Two strategies, kept for comparison. */
  battle: {
    /** 'perf' = within performance %; 'track' = on-track proximity. */
    strategy: "perf" as "perf" | "track",
    perfPctWindow: 1.0, // strategy A: max |Δ% - Δ%| within a group
    trackGapFrac: 0.012, // strategy B: max gap as fraction of a lap
    maxGroupSize: 4,
  },

  /** Camera. */
  camera: {
    transitionRate: 3.2, // ease rate for pan/zoom (1/seconds)
    chaseZoom: 3.0, // base zoom in chase mode (slow corners)
    chaseZoomSpeedSpread: 0.35, // how much speed pulls the zoom out on straights
    fullPadding: 0.08, // fraction padding around track in full view
  },

  /** Overtake visuals. */
  overtake: {
    laneWidthFrac: 0.32, // lateral offset as fraction of track width
    catchGapFrac: 0.02, // start pulling out within this lap-fraction gap
  },
} as const;
