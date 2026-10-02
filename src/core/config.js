// All tunable simulation constants live here so they can be exposed as live
// sliders and captured alongside the seed for reproducible runs.

export const PRESETS = {
  small:  { W: 12000, H: 6000,  spacing: 40, nPlates: 9  },
  medium: { W: 20000, H: 10000, spacing: 50, nPlates: 12 },
  large:  { W: 40000, H: 20000, spacing: 65, nPlates: 16 },
};

export function makeConfig(preset = 'medium', overrides = {}) {
  const p = PRESETS[preset] ?? PRESETS.medium;
  return Object.assign({
    preset,
    seed: 1234,

    // --- domain -----------------------------------------------------------
    W: p.W,                  // km
    H: p.H,                  // km
    spacing: p.spacing,      // km, target crust point spacing
    dt: 1.0,                 // Myr

    // --- initial condition ------------------------------------------------
    nPlates: p.nPlates,
    continentalFraction: 0.32,   // target fraction of area that is continental
    continentNoiseScale: 3.2,    // octaves of value noise across the domain

    // --- plate kinematics -------------------------------------------------
    speedMin: 10,            // km/Myr
    speedMax: 110,
    omegaMax: 1.2e-2,        // rad/Myr, further capped by rimSpeedCap
    rimSpeedCap: 150,        // km/Myr, fastest allowed point speed on a plate
    // Force balance: steady speed is force / drag, so these numbers are
    // directly interpretable. drag = 0.035 gives a ~29 Myr relaxation time.
    drag: 0.035,             // 1/Myr
    basalDrag: 0.10,         // 1/Myr of coupling to the mantle flow beneath
    basalTorqueGain: 0.5,    // how much of the shear torque a plate feels
    // What is left of the old random forcing. The mantle field is the driver
    // now; this is a small residual so that a plate sitting over a stagnant
    // patch of mantle is not perfectly still.
    bgForce: 0.25,           // km/Myr^2
    bgTorque: 1.2e-4,
    forceCorrelation: 45,    // Myr; how long a residual force persists
    // Past about 10 the system destabilises: runaway slab pull drives
    // convergence everywhere and the world sutures itself down to one or two
    // plates within a couple of hundred Myr.
    slabPullGain: 7.0,       // km/Myr^2 at full slab attachment
    slabPullRef: 0.22,       // fraction of a plate's points under slab pull
                             //   that counts as "fully attached"
    ridgePushGain: 0.010,
    momentumDamping: 0.25,   // fraction of net system momentum removed per step

    // --- crust ------------------------------------------------------------
    thickOcean: 7.0,         // km
    // 38 km puts undisturbed continental interior near +0.9 km, which is about
    // Earth's mean land elevation, and leaves thinned margins (30-34 km) below
    // sea level as shelf. At 35 km the interior sits at +0.4 and a kilometre of
    // ordinary thickness variation flickers the coastline on and off.
    thickContinent: 38.0,
    // thickMaxRoot is the orogenic root that gravitational spreading pulls
    // crust back toward, NOT a clamp on transfers. Clamping there throws away
    // whatever will not fit, and in a fast collision that is most of the
    // incoming volume. thickHardCap is only a numerical backstop.
    thickMaxRoot: 72.0,
    thickHardCap: 125.0,
    decimateFactor: 0.55,    // kill a point closer than this * spacing to a peer

    // --- lithosphere ------------------------------------------------------
    // Oceanic lithosphere thickens as sqrt(age); continental needs a separate
    // rule because cratonic roots exceed 200 km at ages in the billions.
    lithoOceanCoef: 9.5,     // km per sqrt(Myr)
    lithoOceanMax: 125,      // km
    lithoContNew: 85,        // km, freshly deformed continental lithosphere
    lithoContMax: 230,       // km, cratonic root
    lithoContGrow: 0.10,     // km/Myr of root growth since last deformation
    lithoRelax: 0.06,        // per Myr, approach to the target thickness
    // Cratonic roots are cold (dense) but chemically depleted (light) and the
    // two effects nearly cancel -- the isopycnic picture -- so continental
    // lithosphere is given only a slight net buoyancy. Oceanic lithosphere is
    // cold without the depletion, hence denser than the asthenosphere.
    rhoLithOcean: 3345,      // kg/m^3
    rhoLithCont: 3292,

    // --- mantle ------------------------------------------------------------
    mantleEnabled: true,
    mantleCellsPerSpacing: 2,   // grid cell = spacing * this
    mantleHeating: 1.0,         // basal heat input per Myr
    mantleCooling: 1.0,         // overall strength of cooling through the lid
    mantleCoolingRef: 60,       // km of lithosphere giving unit conductance
    mantleSlabChill: 2.6,       // cooling per unit of subducted negative buoyancy
    mantleDiffusivity: 600,     // km^2/Myr
    mantleFlowSpeed: 90,        // km/Myr, RMS of the plate-scale flow
    mantleTractionScale: 450,   // km; the wavelength a plate feels as coherent
    mantleIterations: 24,       // SOR sweeps per step, warm-started
    mantleSOR: 1.82,            // over-relaxation factor

    // --- hotspots ----------------------------------------------------------
    plumeThreshold: 2.0,        // standard deviations above the mean to count
    plumeSeparation: 700,       // km; minimum spacing between distinct plumes
    plumeMatchRadius: 500,      // km, for carrying plume IDs forward
    plumeGrace: 6,              // Myr a plume may flicker out and still persist
    plumeRadius: 260,           // km of crust affected
    plumeThickening: 0.22,      // km/Myr of basalt piled on at the centre
    plumeMagmaContinental: 0.18,// plume magma is basaltic, not andesitic
    plumeLithoThinning: 0.9,    // km/Myr of lithosphere removed beneath
    plumeWeakening: 0.012,      // per Myr

    // --- derived geophysics ------------------------------------------------
    thermalConductivity: 3.0,    // W/(m K), bulk lithosphere
    asthenosphereT: 1350,        // K above the surface temperature
    crustHeatProduction: 0.9e-6, // W/m^3 in fully continental crust
    heatFlowMinLitho: 7,         // km; keeps the ridge axis finite
    // The reference column: normal continental crust on a mature root. It sets
    // the zero of both gravity fields, so it has to be the same column the
    // isostasy model puts at sea level.
    gravityRefCrust: 33,             // km
    gravityRefLitho: 145,            // km
    gravityCompensationDepth: 250,   // km

    // --- isostasy / age-depth ---------------------------------------------
    rhoCrustCont: 2700,
    rhoCrustOcean: 2900,
    rhoMantle: 3300,         // asthenosphere reference density
    datum: 6.32,             // km, calibrated against the sanity table below
    ridgeDepth: 2600,        // m, depth of zero-age seafloor
    coolingCoef: 345,        // m per sqrt(Myr)
    coolingFlatten: 5850,    // m, DMAX for old seafloor
    coolingBlendLo: 70,      // Myr, smoothstep start of the flattening blend
    coolingBlendHi: 110,     // Myr, smoothstep end
    seaLevel: 0.0,           // km; dynamic sea level adjusts this
    dynamicSeaLevel: true,
    oceanVolumeRelax: 0.08,  // how fast sea level chases the fixed-volume solution

    // --- boundary processes ----------------------------------------------
    // Only a small fraction of the incoming column is scraped off. At 0.28 a
    // 60 km/Myr trench builds ~0.8 km/Myr of wedge, which saturates the
    // orogenic-root cap within a few Myr and throws the overflow away.
    subductBuoyancyLimit: 0.50,  // crust more continental than this jams the trench
    jamClosureGain: 3.0,     // how fast a jammed trench counts toward suturing
    wedgeFraction: 0.06,
    wedgeRange: 4.0,         // in units of spacing
    arcThicknessRate: 0.13,  // km/Myr added at the arc
    arcMagmaContinental: 0.80,   // bulk arc magma composition
    arcEruptedFraction: 0.42,    // of arc magma that erupts; the rest intrudes
    arcPlutonDepth: 0.55,        // fractional depth the plutons freeze at
    arcWidth: 1.8,           // in units of spacing
    arcSlabDepth: 105,       // km; arc target depth, not a threshold
    arcSlabDepthLo: 65,      // km; real arcs span roughly 65-130 km
    arcSlabDepthHi: 130,
    collisionThickenRate: 0.55,  // km/Myr at the suture
    collisionRange: 7.0,     // in units of spacing
    sutureConvergence: 900,  // km of accumulated closure before plates weld
    transpressionGain: 0.05, // km/Myr per (km/Myr) of fault-normal motion

    // --- subduction polarity ---------------------------------------------
    // Polarity is scored once at initiation and locked. Re-scoring every step
    // makes boundaries flip between steps and corrupts the slab layer.
    polarityAgeWeight: 1.0,
    polarityWeaknessWeight: 0.6,
    polarityLithoWeight: 0.8,
    polarityNoise: 0.45,
    polarityReviewInterval: 60,   // Myr between re-evaluations

    // --- trench / hinge kinematics ---------------------------------------
    rollbackBuoyGain: 0.55,   // km/Myr per unit negative buoyancy
    rollbackDipGain: 1.0,
    rollbackAnchorGain: 0.35, // resistance from the overriding plate's advance
    rollbackLengthRef: 400,   // km of slab length for full rollback expression
    trenchSmoothing: 0.25,    // per step relaxation of trench state

    // --- slab layer -------------------------------------------------------
    slabSinkBase: 12.0,      // km/Myr for zero-age oceanic crust
    slabSinkAgeGain: 0.16,   // extra km/Myr per sqrt(Myr) of age at subduction
    slabSinkContResist: 0.85,// fraction of sink rate removed at continental = 1
    slabDipInit: 0.52,       // rad (~30 deg) at the trench
    slabDipMax: 1.15,        // rad (~66 deg)
    slabDipRate: 0.02,       // rad/Myr steepening
    slabCouplingDecay: 0.972,// per Myr
    slabRetireDepth: 660,    // km
    slabMaxAge: 260,         // Myr; older slabs have detached and are retired
    flatSlabAgeMax: 35,      // Myr; younger downgoing crust flattens the slab
    flatSlabRateMin: 70,     // km/Myr convergence needed to flatten
    rollbackGain: 0.10,      // km/Myr of thinning under rollback
    flatSlabGain: 0.09,      // km/Myr of thickening under a flat slab
    slabWindowUplift: 0.12,  // km/Myr of thickening over a slab hole

    // --- ridge segmentation ----------------------------------------------
    segLenSlow: 90,          // km at slow spreading
    segLenFast: 320,         // km at fast spreading
    segRateSlow: 20,         // km/Myr
    segRateFast: 150,
    segMatchRadius: 320,     // km, for carrying segment IDs forward
    segGraceSteps: 8,        // steps a segment may go unmatched before it dies
    segWeaknessMod: 0.45,    // inherited weakness shortens segments
    segNoiseMod: 0.30,       // per-segment jitter so ridges are not periodic

    // --- weakness ---------------------------------------------------------
    weaknessHalfLife: 160,   // Myr
    weakCollision: 0.9,
    weakRift: 0.7,
    weakTransform: 0.35,
    weakArc: 0.45,

    // --- rifting ----------------------------------------------------------
    // Stress first, weakness second. Continental area alone would make the
    // largest continent rift simply for being large.
    insulationStress: 0.004, // extension under a large insulating continent
    riftStressWeight: 1.0,
    riftWeaknessWeight: 0.55,
    riftAreaWeight: 0.25,
    riftMinArea: 0.045,      // fraction of domain area a plate needs to rift
    riftMinContArea: 0.022,
    riftLithoCost: 1.4,      // how strongly thick cratonic roots deflect a rift
    riftCooldown: 20,        // Myr after a reorganization before rifting again
    riftBaseChance: 0.05,    // per step, scaled by the rift score
    riftThinRate: 0.45,      // km/Myr of crustal thinning on the rift axis
    riftThinRange: 2.2,      // in units of spacing
    riftBreakupThickness: 19,// km; below this the rift becomes a spreading centre
    riftOpenSpeed: 26,       // km/Myr of imposed divergence across a new rift

    // --- rasterisation ----------------------------------------------------
    rasterCellsPerSpacing: 2,  // grid cell = spacing / this
    splatRadiusFactor: 2.0,    // in units of spacing
    splatSigmaFactor: 0.92,

    // --- surface processes --------------------------------------------------
    // Sedimentary rock needs a source. These are the two that do not require a
    // drainage model; erosion here is a conservative mass transfer, not the
    // stream-power pass the original spec ruled out.
    sedimentEnabled: true,
    erosionEnabled: true,
    pelagicRate: 0.0022,     // km/Myr of pelagic rain on the abyssal plain
    shelfSedimentRate: 0.055,// km/Myr extra in shallow water near land
    sedimentFelsic: 0.45,    // continental character of sedimentary rock
    // Pelagic sediment reaches ~0.5 km over a few hundred Myr, which is
    // correct, so a 0.35 km cutoff made the entire sea floor read as cover and
    // the map a single colour. The threshold has to sit above the ordinary
    // pelagic blanket and below a real basin fill.
    bedrockVeneer: 1.2,      // km; surface geology ignores cover thinner than this
    erosionRate: 0.030,      // km/Myr per km of relief above sea level
    erosionMaxStrip: 0.28,   // km/Myr ceiling, so a new orogen is not shaved flat
    erosionRange: 3.0,       // in units of spacing, how far debris travels

    // --- metamorphism -------------------------------------------------------
    metamorphismEnabled: true,
    surfaceT: 10,            // deg C at the surface
    maxGeotherm: 45,         // deg C per km, ceiling on the conductive gradient
    eclogiteP: 12,           // kbar above which cold mafic rock eclogitises
    eclogiteTmax: 650,       // deg C; hotter than this gives amphibolite instead
    eclogiteDepth: 55,       // km at which slab crust begins converting
    eclogiteRate: 0.06,      // per Myr conversion rate once deep enough
    eclogitePullGain: 0.55,  // extra slab pull from a fully eclogitised slab

    // --- gravitational spreading -------------------------------------------
    // Crust much thicker than the orogenic cap is gravitationally unstable and
    // flows laterally in the lower crust. This is orogenic collapse, not
    // erosion: it is mass-conserving and moves nothing off the plate. Without
    // it, thickening processes pile volume onto a handful of saturated points
    // and the overflow has nowhere to go.
    spreadThreshold: 50,     // km; flow starts above this
    spreadRate: 0.14,        // per Myr, fraction of the excess moved
    spreadEnabled: true,

    // --- point density management -----------------------------------------
    // Rifting stretches the cloud and collision compresses it. Without
    // insertion and merging, spacing drifts badly over a few hundred Myr:
    // gaps in extended crust, pileups in orogens.
    densityMergeFactor: 0.58,  // merge peers closer than this * spacing
    densitySplitFactor: 0.78,  // insert where a triangle's circumradius exceeds this
    densityMaxOpsPerStep: 4000,

    // --- diagnostics -------------------------------------------------------
    quakeRate: 0.9,          // events per 1000 km of boundary per Myr
    quakeMaxStore: 4000,

    // --- history ----------------------------------------------------------
    snapshotEvery: 10,       // Myr
    maxSnapshots: 400,
  }, overrides);
}
