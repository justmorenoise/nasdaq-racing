/**
 * Central tunables. Everything that affects "feel" lives here so it can be
 * tweaked without hunting through modules.
 */
export const CONFIG = {
  /** Daily % change is clamped to this band before mapping to lap time. */
  changePctClamp: 8,

  /** Debug overlays - off in normal use. */
  debug: {
    /** Show the focused car's current gear (a small badge over the circuit). */
    showGear: true,
  },

  /**
   * Broker affiliate CTAs (the "Investi" links/buttons and every eToro
   * reference added on top of the viewer). Set to `false` to hide all of them:
   * leaderboard ↗ buttons, podium "Investi" pills, the global "Apri conto"
   * button, the chase-cam link and the compliance disclaimer.
   */
  affiliateEnabled: false,

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
    vMin: 0.42, // slowest corner as a fraction of top speed (F1 carry plenty of speed)
    vMax: 1.0, // straight-line top speed
    accel: 6, // acceleration limit (rel-speed² gained per lap-fraction)
    brake: 13, // braking limit (rel-speed² shed per lap-fraction)
    corneringPercentile: 0.9, // curvature percentile that maps to vMin
    /** Severity curve exponent on (κ/κ_ref): 0.5 = √ (brakes a lot even for gentle
     *  bends); higher (→1) keeps medium/fast corners closer to top speed, so only
     *  the tightest really slow down - some sweepers stay near-flat. */
    corneringExp: 0.78,
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
   * Sparks kicked up when two cars touch (side-by-side on the same stretch).
   * Intensity is derived from how hard the contact is (closing speed + how far
   * inside each other their lanes are) and scales the burst size/energy, so the
   * whole effect can be dialed up or down here.
   */
  sparks: {
    /** Max along-track gap to count as contact (lap-fraction). */
    contactLongFrac: 0.006,
    /** Max lateral overlap to count as contact (world units; ~car width). */
    contactLatUnits: 13,
    /** Below this normalized intensity [0,1] no sparks are emitted. */
    minIntensity: 0.12,
    /** Closing speed (world units/s) that maps to full intensity. */
    fullClosingSpeed: 90,
    /** Particles emitted at full intensity (scaled down for softer touches). */
    particleCount: 14,
    /** Per-event cooldown so a sustained scrape doesn't spam (seconds). */
    cooldown: 0.18,
    /** Particle lifetime range (seconds). */
    lifeMin: 0.18,
    lifeMax: 0.5,
    /** Initial particle speed range (world units/s) at full intensity. */
    speedMin: 60,
    speedMax: 220,
    /** Downward pull on particles (world units/s²) - they arc and settle. */
    gravity: 320,
    /** Spread half-angle around the contact tangent (radians). */
    spread: Math.PI * 0.6,
    /** Hot core (white) and cooler edge (orange) colours. */
    colorHot: 0xffffff,
    colorWarm: 0xffb24a,
  },

  /**
   * Decorative circuit scenery (render-only): kerbs, gravel run-off, grass,
   * grandstands, pit/paddock, tire walls and cranes - all derived from the
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
    /** Min straight lap-fraction to host a grandstand (lower = more stands, as
     *  shorter straights also qualify). */
    standMinStraightFrac: 0.05,
    /** Every circuit gets at least this many stands; sparse tracks (Monaco, Spa)
     *  trigger relaxed fallback passes until they reach it. */
    minStands: 5,

    /** Pit lane + paddock complex along the start/finish straight. Measured from
     *  the real track edge and depth-capped to the infield clearance, so it stays
     *  near the finish line without ever reaching onto another part of the track. */
    pitLaneWidth: 14,
    pitLaneGap: 8, // gap between track edge and pit lane
    pitLaneLen: 210, // length along the straight (short, to stay off the corners)
    garageDepth: 16, // garage building band depth
    paddockDepth: 26, // paddock band depth behind the garages

    /** Tire wall: a continuous packed barrier lining the corner run-off. */
    tireRadius: 5,
    tireGap: 54, // distance outside the real track edge (just beyond the run-off)
    tireSpacing: 9, // center-to-center along the wall (< 2·radius → tires touch)

    /** Cranes: how many of the sharpest corners get one, and its size. */
    craneCount: 3,
    craneGap: 96, // distance from track edge

    /** Texture tile scale: world units per texture tile (bigger = coarser). */
    asphaltTile: 64,
    grassTile: 90,
    grassBgTile: 3, // bg.jpg tonal overlay, tiled at native 1024×1024 over the field
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
