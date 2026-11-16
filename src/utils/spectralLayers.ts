// The maps in the Spectral view. "all" is the median of the cube; the others are Daniel's
// feature maps (science/analysis.py FEATURES: same ids, centres and continuum windows).
export type SpectralLayerId = 'all' | 'pah' | 'water' | 'co2' | 'co'

export type SpectralLayer = {
  id: SpectralLayerId
  button: string // short, for the button and the plate badge
  title: string
  wavelength?: string // the colour the map measures
  explain: string // what the map shows, in plain words
  low: string // legend ends
  high: string
  logarithmic: boolean // how the map is drawn (as in Daniel's ScientificMap)
}

export const SPECTRAL_LAYERS: SpectralLayer[] = [
  {
    id: 'all',
    button: 'All light',
    title: 'All light',
    explain:
      'All 102 colours and every visit combined into one picture of how bright the field is.',
    low: 'Faint',
    high: 'Bright',
    logarithmic: true,
  },
  {
    id: 'pah',
    button: 'Carbon',
    title: 'Carbon particles',
    wavelength: '3.3 µm',
    explain:
      'Tiny carbon-rich dust grains (PAHs) glow at 3.3 µm when starlight warms them. Brighter means more of that extra glow.',
    low: 'Less glow',
    high: 'More glow',
    logarithmic: false,
  },
  {
    id: 'water',
    button: 'Water ice',
    title: 'Water ice',
    wavelength: '3.05 µm',
    explain:
      'Water ice on cold dust grains soaks up light at 3.05 µm. Brighter means more of that light is missing: a hint of ice.',
    low: 'Weaker hint',
    high: 'Stronger hint',
    logarithmic: false,
  },
  {
    id: 'co2',
    button: 'CO₂ ice',
    title: 'Carbon dioxide ice',
    wavelength: '4.27 µm',
    explain:
      'Frozen carbon dioxide soaks up light at 4.27 µm. Brighter means more of that light is missing.',
    low: 'Weaker hint',
    high: 'Stronger hint',
    logarithmic: false,
  },
  {
    id: 'co',
    button: 'CO ice',
    title: 'Carbon monoxide ice',
    wavelength: '4.67 µm',
    explain:
      'Frozen carbon monoxide, found only in the coldest places, soaks up light at 4.67 µm. Brighter means more of that light is missing.',
    low: 'Weaker hint',
    high: 'Stronger hint',
    logarithmic: false,
  },
]

export const layerById = (id: SpectralLayerId) =>
  SPECTRAL_LAYERS.find((l) => l.id === id) ?? SPECTRAL_LAYERS[0]
