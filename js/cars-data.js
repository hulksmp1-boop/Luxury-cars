/**
 * Featured vehicle data (frontend-only, structured for later CMS/backend use).
 * Figures are manufacturer-quoted; a field is omitted where it is not reliably available.
 * power.ps = metric horsepower; power.hp = mechanical horsepower (PS x 0.986, rounded).
 * `year` is the model year / year the current generation was introduced.
 */
window.LA_CARS = [
  {
    id: 'rolls-royce-spectre', manufacturer: 'Rolls-Royce', model: 'Spectre', year: 2024,
    category: 'Electric Luxury Coupé', powertrain: 'Dual-motor electric',
    power: { ps: 585, hp: 577 }, torqueNm: 900, zeroTo100: '4.5 s', topSpeed: '250 km/h',
    extras: [['Battery', '102 kWh']],
    summary: 'The marque\u2019s first series-production electric car, built for silent, effortless progress.',
    description: 'Spectre carries Rolls-Royce\u2019s “magic carpet ride” into the electric era: a monumental two-door coupé with a serene cabin and a seamless wave of torque. Top speed is electronically limited.',
    image: 'assets/images/cars/rolls-royce-spectre.jpg'
  },
  {
    id: 'bentley-continental-gt', manufacturer: 'Bentley', model: 'Continental GT Speed', year: 2025,
    category: 'Grand Tourer', powertrain: '4.0L twin-turbo V8 plug-in hybrid',
    power: { ps: 782, hp: 771 }, torqueNm: 1000, zeroTo100: '3.2 s', topSpeed: '335 km/h',
    extras: [['Drivetrain', 'All-wheel drive']],
    summary: 'The definitive grand tourer, now with the most powerful powertrain in Bentley\u2019s history.',
    description: 'The fourth-generation Continental GT pairs hand-finished British luxury with a plug-in hybrid V8. Shown here in Speed specification, the most performance-focused version of the range.',
    image: 'assets/images/cars/bentley-continental-gt.jpg'
  },
  {
    id: 'mercedes-amg-gt', manufacturer: 'Mercedes-AMG', model: 'GT 63', year: 2024,
    category: 'Grand Tourer', powertrain: '4.0L twin-turbo V8',
    power: { ps: 585, hp: 577 }, torqueNm: 800, zeroTo100: '3.2 s', topSpeed: '315 km/h',
    extras: [['Drivetrain', 'All-wheel drive']],
    summary: 'Affalterbach\u2019s second-generation GT: sharper, more practical and unmistakably AMG.',
    description: 'The new AMG GT moves to a 2+2 layout with a hand-built V8 and a long-bonnet, fastback silhouette, balancing everyday usability with track-ready dynamics.',
    image: 'assets/images/cars/mercedes-amg-gt.jpg'
  },
  {
    id: 'porsche-911-turbo-s', manufacturer: 'Porsche', model: '911 Turbo S', year: 2025,
    category: 'Sports Coupé', powertrain: '3.6L twin-turbo flat-six hybrid',
    power: { ps: 711, hp: 701 }, torqueNm: 800, zeroTo100: '2.5 s', topSpeed: '322 km/h',
    extras: [['Drivetrain', 'All-wheel drive']],
    summary: 'The everyday supercar, redefined with Porsche\u2019s first hybrid 911 Turbo.',
    description: 'The 992.2 Turbo S introduces the T-Hybrid system to the 911 Turbo line, delivering staggering acceleration with the usability and precision the nameplate is known for.',
    image: 'assets/images/cars/porsche-911-turbo-s.jpg'
  },
  {
    id: 'ferrari-296-gtb', manufacturer: 'Ferrari', model: '296 GTB', year: 2022,
    category: 'Hybrid Supercar', powertrain: '3.0L twin-turbo V6 plug-in hybrid',
    power: { ps: 830, hp: 819 }, torqueNm: 740, zeroTo100: '2.9 s', topSpeed: '330 km/h',
    extras: [['Combustion / electric', '663 PS / 167 PS']],
    summary: 'Ferrari\u2019s first series-production V6 berlinetta, with a plug-in hybrid heart.',
    description: 'A compact, rear-wheel-drive mid-engined berlinetta that fuses a 120-degree V6 with an electric motor, built around the pure, playful driving feel of classic small-capacity Ferraris.',
    image: 'assets/images/cars/ferrari-296-gtb.jpg'
  },
  {
    id: 'lamborghini-revuelto', manufacturer: 'Lamborghini', model: 'Revuelto', year: 2024,
    category: 'Hybrid Supercar', powertrain: '6.5L V12 plug-in hybrid',
    power: { ps: 1015, hp: 1001 }, zeroTo100: '2.5 s', topSpeed: '350+ km/h',
    extras: [['Electric motors', 'Three'], ['Drivetrain', 'All-wheel drive']],
    summary: 'The first Lamborghini V12 plug-in hybrid, and successor to the Aventador.',
    description: 'Revuelto combines a naturally aspirated V12 with three electric motors in an all-new carbon-fibre structure, preserving the theatre of a Lamborghini flagship while taking performance into a new era.',
    image: 'assets/images/cars/lamborghini-revuelto.jpg'
  },
  {
    id: 'aston-martin-db12', manufacturer: 'Aston Martin', model: 'DB12', year: 2024,
    category: 'Grand Tourer', powertrain: '4.0L twin-turbo V8',
    power: { ps: 680, hp: 671 }, torqueNm: 800, zeroTo100: '3.6 s', topSpeed: '325 km/h',
    extras: [['Drivetrain', 'Rear-wheel drive']],
    summary: 'The “Super Tourer” that sets a new standard for the DB lineage.',
    description: 'DB12 blends sculpted British design with a V8 powertrain and a refined, tech-forward cabin, positioned as both a comfortable long-distance companion and a genuinely sharp driver\u2019s car.',
    image: 'assets/images/cars/aston-martin-db12.jpg'
  },
  {
    id: 'mclaren-750s', manufacturer: 'McLaren', model: '750S', year: 2023,
    category: 'Supercar', powertrain: '4.0L twin-turbo V8',
    power: { ps: 750, hp: 740 }, torqueNm: 800, zeroTo100: '2.8 s', topSpeed: '332 km/h',
    extras: [['Drivetrain', 'Rear-wheel drive']],
    summary: 'A lighter, faster, more engaging evolution of McLaren\u2019s Super Series.',
    description: 'Built around a carbon-fibre monocoque, the 750S sharpens the 720S with more power, reduced weight and a pure, communicative driving character that remains McLaren\u2019s signature.',
    image: 'assets/images/cars/mclaren-750s.jpg'
  }
];
