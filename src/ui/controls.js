// Panel construction. Every constant the spec calls out for tuning is exposed
// here as a live slider, alongside the seed, so a run is reproducible and can
// be re-tuned without a reload.

export const TUNING = [
  { group: 'Ridge segmentation', keys: [
    ['segLenSlow', 'L_seg at slow spreading', 30, 300, 5, 'km'],
    ['segLenFast', 'L_seg at fast spreading', 100, 700, 10, 'km'],
    ['segWeaknessMod', 'weakness shortening of L_seg', 0, 0.9, 0.05, ''],
    ['segNoiseMod', 'L_seg jitter', 0, 0.8, 0.05, ''],
    ['segMatchRadius', 'segment ID match radius', 80, 600, 10, 'km'],
  ]},
  { group: 'Surface processes', keys: [
    ['pelagicRate', 'pelagic deposition', 0, 0.02, 0.0005, 'km/Myr'],
    ['shelfSedimentRate', 'shelf deposition', 0, 0.3, 0.005, 'km/Myr'],
    ['erosionRate', 'erosion rate', 0, 0.15, 0.002, '/Myr'],
    ['erosionMaxStrip', 'erosion ceiling', 0, 1, 0.02, 'km/Myr'],
    ['erosionRange', 'debris transport', 1, 8, 0.25, '×spacing'],
    ['pelagicFelsic', 'pelagic composition', 0, 0.6, 0.02, 'cont.'],
    ['shelfFelsic', 'terrigenous composition', 0.2, 0.95, 0.02, 'cont.'],
    ['maxGeotherm', 'max geotherm', 15, 80, 1, '°C/km'],
    ['eclogiteP', 'eclogite pressure', 6, 20, 0.5, 'kbar'],
    ['bedrockVeneer', 'bedrock veneer cutoff', 0, 1.5, 0.05, 'km'],
  ]},
  { group: 'Crust & isostasy', keys: [
    ['datum', 'isostatic DATUM', 4, 8, 0.02, 'km'],
    ['thickMaxRoot', 'max orogenic root', 50, 90, 1, 'km'],
    ['spreadThreshold', 'collapse threshold', 35, 70, 1, 'km'],
    ['spreadRate', 'collapse rate', 0, 0.3, 0.005, '/Myr'],
    ['spreadRange', 'collapse reach', 1.5, 8, 0.25, '×spacing'],
    ['coolingFlatten', 'old-seafloor depth', 5000, 6500, 25, 'm'],
    ['seaLevel', 'sea level (static mode)', -3, 3, 0.05, 'km'],
    ['oceanVolumeRelax', 'sea-level response', 0.01, 0.5, 0.01, '/step'],
  ]},
  { group: 'Boundary processes', keys: [
    ['wedgeFraction', 'wedge transfer fraction', 0, 0.4, 0.01, ''],
    ['wedgeRange', 'wedge range', 1, 8, 0.2, '×spacing'],
    ['arcThicknessRate', 'arc thickening', 0, 0.5, 0.01, 'km/Myr'],
    ['arcMagmaContinental', 'arc magma composition', 0.3, 1, 0.02, 'cont.'],
    ['meltEruptFrac', 'eruption rate', 0.02, 0.6, 0.02, '/Myr'],
    ['meltFreezeFrac', 'crystallisation rate', 0.02, 0.6, 0.02, '/Myr'],
    ['arcPlutonDepth', 'arc chamber depth', 0.2, 0.95, 0.05, 'of crust'],
    ['subductBuoyancyLimit', 'buoyancy jam limit', 0.1, 0.8, 0.02, 'cont.'],
    ['sutureConvergence', 'closure before welding', 200, 3000, 50, 'km'],
    ['jamClosureGain', 'jam → suture rate', 0, 10, 0.5, ''],
  ]},
  { group: 'Slab layer', keys: [
    ['slabSinkBase', 'slab sink rate', 2, 40, 0.5, 'km/Myr'],
    ['slabSinkContResist', 'continental sink resistance', 0, 1, 0.02, ''],
    ['slabDipMax', 'max dip', 0.4, 1.5, 0.02, 'rad'],
    ['slabDipAgeGain', 'dip from slab age', 0, 1.2, 0.02, 'rad'],
    ['slabDipDepthGain', 'dip steepening with depth', 0, 0.8, 0.02, 'rad'],
    ['slabMaxAge', 'slab detachment age', 80, 600, 10, 'Myr'],
    ['eclogiteDepth', 'eclogite onset depth', 20, 150, 5, 'km'],
    ['eclogitePullGain', 'eclogite slab pull', 0, 2, 0.05, ''],
    ['flatSlabAgeMax', 'flat-slab age ceiling', 10, 90, 2, 'Myr'],
    ['flatSlabGain', 'flat-slab thickening', 0, 0.3, 0.005, 'km/Myr'],
    ['rollbackGain', 'rollback thinning', 0, 0.3, 0.005, 'km/Myr'],
    ['rollbackBuoyGain', 'rollback drive', 0, 2, 0.05, ''],
  ]},
  { group: 'Weakness & reorganisation', keys: [
    ['insulationStress', 'continental insulation', 0, 0.02, 0.001, ''],
    ['weaknessHalfLife', 'weakness half-life', 40, 800, 10, 'Myr'],
    ['riftBaseChance', 'rift trigger threshold', 0, 0.08, 0.002, '/Myr'],
    ['riftLithoCost', 'craton avoidance', 0, 4, 0.1, ''],
    ['riftThinRate', 'rift thinning', 0.05, 1.5, 0.05, 'km/Myr'],
    ['riftBreakupThickness', 'breakup thickness', 10, 28, 0.5, 'km'],
    ['riftOpenSpeed', 'imposed rift opening', 5, 70, 1, 'km/Myr'],
  ]},
  { group: 'Mantle & hotspots', keys: [
    ['mantleFlowSpeed', 'mantle flow speed', 0, 120, 2, 'km/Myr'],
    ['mantleTractionScale', 'coherent flow scale', 100, 1500, 50, 'km'],
    ['basalDrag', 'basal coupling', 0, 0.3, 0.005, '/Myr'],
    ['basalTorqueGain', 'basal torque', 0, 2, 0.05, ''],
    ['mantleCooling', 'cooling through the lid', 0.1, 4, 0.1, ''],
    ['mantleCoolingRef', 'insulation reference', 20, 160, 5, 'km'],
    ['mantleSlabChill', 'slab chilling', 0, 10, 0.2, ''],
    ['mantleDiffusivity', 'mantle diffusivity', 100, 2000, 50, 'km²/Myr'],
    ['plumeThreshold', 'plume threshold', 0.8, 3.5, 0.1, 'σ'],
    ['plumeSeparation', 'plume separation', 200, 1800, 50, 'km'],
    ['plumeThickening', 'plume output', 0, 0.8, 0.02, 'km/Myr'],
    ['plumeRadius', 'plume radius', 80, 600, 10, 'km'],
  ]},
  { group: 'Kinematics', keys: [
    ['speedMax', 'max plate speed', 20, 160, 5, 'km/Myr'],
    ['drag', 'mantle drag', 0.005, 0.12, 0.005, '/Myr'],
    ['bgForce', 'background drive', 0, 5, 0.1, 'km/Myr²'],
    ['forceCorrelation', 'drive persistence', 5, 200, 5, 'Myr'],
    ['slabPullGain', 'slab pull', 0, 8, 0.1, 'km/Myr²'],
    ['ridgePushGain', 'ridge push', 0, 0.06, 0.002, ''],
    ['omegaMax', 'max angular velocity', 0, 0.03, 0.001, 'rad/Myr'],
  ]},
  { group: 'Point cloud & rendering', keys: [
    ['densityMergeFactor', 'merge threshold', 0.3, 0.9, 0.02, '×spacing'],
    ['densitySplitFactor', 'insertion threshold', 0.5, 1.6, 0.02, '×spacing'],
    ['splatRadiusFactor', 'splat radius', 1, 4, 0.1, '×spacing'],
    ['splatSigmaFactor', 'splat sigma', 0.3, 2, 0.05, '×spacing'],
    ['quakeRate', 'seismicity rate', 0, 4, 0.1, '/1000km/Myr'],
  ]},
];

export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of kids) if (c) n.append(c);
  return n;
}

export function slider(cfg, key, label, min, max, step, unit, onChange) {
  const val = el('b', { text: fmt(cfg[key], step) + (unit ? ' ' + unit : '') });
  const input = el('input', {
    type: 'range', min, max, step, value: cfg[key],
    oninput: (e) => {
      cfg[key] = +e.target.value;
      val.textContent = fmt(cfg[key], step) + (unit ? ' ' + unit : '');
      onChange && onChange(key, cfg[key]);
    },
  });
  return el('div', { class: 'field' }, el('label', {}, el('span', { text: label }), val), input);
}

function fmt(v, step) {
  const d = step >= 1 ? 0 : String(step).split('.')[1].length;
  return v.toFixed(d);
}

export function toggles(obj, onChange) {
  const wrap = el('div', { class: 'toggles' });
  for (const k of Object.keys(obj)) {
    const cb = el('input', {
      type: 'checkbox',
      onchange: (e) => { obj[k] = e.target.checked; onChange && onChange(); },
    });
    cb.checked = obj[k];
    wrap.append(el('label', {}, cb, el('span', { text: k })));
  }
  return wrap;
}
