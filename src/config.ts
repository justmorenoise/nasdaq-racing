/**
 * Central tunables. Everything that affects "feel" lives here so it can be
 * tweaked without hunting through modules.
 */
export const CONFIG = {
  /** Daily % change is clamped to this band before mapping to lap time. */
  changePctClamp: 8,

  /** Lateral offset easing for overtakes (1/seconds). */
  laneEaseRate: 2.5,

  /**
   * Standings-driven positioning: the on-track order reflects the % leaderboard.
   * Each car targets a slot behind the standings leader whose gap grows with the
   * cumulative % differences; a proportional controller steers it there smoothly
   * (animating overtakes) while the corner speed profile still applies.
   */
  pace: {
    baseGapFrac: 0.02, // lap-fraction of spacing between adjacent cars (readability)
    gapPerPctFrac: 0.03, // extra lap-fraction of spacing per 1% of standings gap
    gain: 6, // controller gain toward the target slot (higher = snappier)
    minMul: 0.3, // clamp on the pace multiplier (slowest)
    maxMul: 2.4, // clamp on the pace multiplier (fastest, for catching up)
  },

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
    perfPctWindow: 0.1, // strategy A: max |Δ% - Δ%| within a group
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

  /**
   * Decorative circuit scenery (render-only): kerbs, gravel run-off, grass,
   * grandstands, pit/paddock, tire walls and cranes — all derived from the
   * track geometry, built once. Curvature is normalized per track (a high
   * percentile maps to 1) so thresholds work on any circuit.
   */
  scenery: {
    /** Curvature percentile that maps to severity 1 when detecting corners. */
    cornerPercentile: 0.9,
    /** Normalized severity to enter / leave a corner run (hysteresis). */
    cornerEnter: 0.28,
    cornerExit: 0.16,
    /** Ignore corner runs / straights shorter than this lap-fraction. */
    minRunFrac: 0.018,
    minStraightFrac: 0.06,
    /** Bridge corner runs separated by less than this lap-fraction. */
    mergeGapFrac: 0.015,
    /** Apex window as a fraction of a run's length, centered on the peak. */
    apexFrac: 0.3,

    /** Kerb band: width (world units) just outside the asphalt edge, and the
     *  arc-length of one red/white cell. */
    kerbWidth: 7,
    kerbCellLen: 14,

    /** Gravel run-off band width outside the asphalt edge at corners. */
    runOffWidth: 46,
    /** Grass extends this far beyond the track bounding box. */
    grassMargin: 420,

    /** Grandstands: stand depth, gap from track edge, and segment length. */
    standDepth: 60,
    standGap: 70,
    standSegLen: 150,
    /** Min straight lap-fraction to host a grandstand. */
    standMinStraightFrac: 0.08,

    /** Pit lane + paddock complex along the start/finish straight. Kept shallow
     *  and following the track so it never overlaps other parts of the circuit. */
    pitLaneWidth: 24,
    pitLaneGap: 13, // gap between track edge and pit lane
    pitLaneLen: 300, // length along the straight
    garageDepth: 26, // garage building band depth
    paddockDepth: 44, // paddock band depth behind the garages

    /** Tire wall: tire radius and spacing along the corner outside. */
    tireRadius: 5,
    tireGap: 64, // distance from track edge to the wall
    tireSpacing: 11,

    /** Cranes: how many of the sharpest corners get one, and its size. */
    craneCount: 3,
    craneGap: 96, // distance from track edge

    /** Texture tile scale: world units per texture tile (bigger = coarser). */
    asphaltTile: 64,
    grassTile: 90,
    gravelTile: 48,

    /** "New tarmac" patches: a few darker, freshly-resurfaced stretches. Each
     *  entry is a [start, end] lap-fraction span. */
    tarmacPatches: [
      [0.14, 0.24],
      [0.46, 0.575],
      [0.79, 0.86],
    ] as [number, number][],
  },
} as const;
