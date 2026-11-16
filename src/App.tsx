import { useEffect, useState } from 'react'
import DomeHero from './components/DomeHero'
import Divider from './components/Divider'
import TargetBar from './components/TargetBar'
import SkyPlate from './components/SkyPlate'
import PlateCaption from './components/PlateCaption'
import TimelinePanel from './components/TimelinePanel'
import ColourKeyPanel from './components/ColourKeyPanel'
import DifferencePanel from './components/DifferencePanel'
import SpectralPanel from './components/SpectralPanel'
import ViewSwitch from './components/ViewSwitch'
import ObservationLog from './components/ObservationLog'
import StorySection from './components/StorySection'
import UnchartedSpot from './components/UnchartedSpot'
import { defaultComparison, nearestTarget, spotAsTarget, useExplorer } from './hooks/useExplorer'
import { useDifferenceImage } from './hooks/useDifferenceImage'
import { useSpectralMap } from './hooks/useSpectralMap'
import type { PlateImage } from './components/SkyPlate'
import { layerById } from './utils/spectralLayers'
import type { SpectralLayerId } from './utils/spectralLayers'
import { usePreloadImages } from './hooks/usePreloadImages'
import { useUrlState } from './hooks/useUrlState'
import { hasBandImages, imageForBand } from './utils/bands'
import { scrollToSection } from './utils/scroll'

// One page in three parts: the dome (pick a star), the instrument (once a star is picked),
// and the story (how blinking finds moving worlds).
export default function App() {
  const explorer = useExplorer()
  const takeOpenedFromUrl = useUrlState(explorer)
  const selected = explorer.selectedTarget
  const spot = explorer.customSpot
  // What's on the plate: a charted target, or an uncharted spot once its passes are fetched
  const plateTarget =
    selected ?? (spot && explorer.spotFetch.status === 'ready' ? spotAsTarget(spot) : null)
  const passes = explorer.passesData?.passes ?? []
  // The chosen band applies only where single-detector images exist (not simulated targets).
  const bandsAvailable = hasBandImages(passes)
  const band = bandsAvailable
    ? (explorer.colourKey.find((c) => c.band === explorer.band) ?? null)
    : null
  // The Difference view needs single-detector images; simulated targets stay on Blink.
  const comparison = explorer.comparison ?? (bandsAvailable ? defaultComparison(passes) : null)
  const showDifference = explorer.view === 'difference' && comparison !== null
  const [earlier, later] = comparison ? [passes[comparison.from], passes[comparison.to]] : []
  const differenceImage = useDifferenceImage(
    showDifference && comparison ? (earlier?.bandImageUrls?.[comparison.band] ?? null) : null,
    showDifference && comparison ? (later?.bandImageUrls?.[comparison.band] ?? null) : null,
  )
  const difference =
    showDifference && comparison && earlier && later
      ? { from: earlier, to: later, band: comparison.band }
      : null
  // The Spectral view: Daniel's science service makes maps from SPHEREx's all-sky cube
  const [spectralAttempt, setSpectralAttempt] = useState(0)
  const [spectralLayerId, setSpectralLayerId] = useState<SpectralLayerId>('all')
  const spectralLayer = layerById(spectralLayerId)
  // A built-in target by its id; a fetched spot by its position
  const showSpectral = explorer.view === 'spectral' && plateTarget !== null
  const spectralMap = useSpectralMap(
    !showSpectral ? null : selected ? { target: selected.id } : spot,
    spectralAttempt,
  )
  const view = showSpectral ? 'spectral' : showDifference ? 'difference' : 'blink'

  // What the plate shows instead of a pass, in the Difference and Spectral views
  let altImage: PlateImage | null = null
  if (showSpectral && plateTarget && spectralMap) {
    altImage = {
      status:
        spectralMap.status === 'ready'
          ? 'ready'
          : spectralMap.status === 'loading'
            ? 'loading'
            : 'error',
      url: spectralMap.status === 'ready' ? spectralMap.images[spectralLayer.id] : undefined,
      badge: `Spectral · ${spectralLayer.button}`,
      alt: `Spectral map of ${plateTarget.name}: ${spectralLayer.title.toLowerCase()}`,
      loadingText: 'Building the spectral map…',
      errorText: 'The spectral map isn’t available right now.',
    }
  } else if (difference && differenceImage) {
    const label = `${difference.from.label} → ${difference.to.label}`
    altImage = {
      status: differenceImage.status,
      url: differenceImage.status === 'ready' ? differenceImage.url : undefined,
      badge: `Difference · ${label} · ${difference.band}`,
      alt: `Difference plate for ${selected?.name}: ${label}, detector ${difference.band}`,
      loadingText: 'Subtracting…',
      errorText: 'The difference plate couldn’t be made.',
    }
  }

  const framesReady = usePreloadImages(
    passes.map((p) => imageForBand(p, band?.band ?? null)).filter((url) => url !== null),
  )

  // Picking a star, or entering coordinates, takes you down to the plate.
  const selectedId = selected?.id
  useEffect(() => {
    if (!selectedId && !spot) return
    scrollToSection('instrument', takeOpenedFromUrl())
  }, [selectedId, spot, takeOpenedFromUrl])

  return (
    <div className="page">
      <DomeHero
        targets={explorer.targets}
        targetsStatus={explorer.targetsStatus}
        selectedTarget={selected}
        customSpot={spot}
        onSelect={explorer.selectTarget}
        onGoTo={explorer.goToCoordinates}
        onRetry={explorer.retryTargets}
        onContinue={() => scrollToSection(selected || spot ? 'instrument' : 'story')}
      />

      <main>
        {spot && !plateTarget && (
          <div className="instrument" id="instrument">
            <UnchartedSpot
              spot={spot}
              nearest={nearestTarget(explorer.targets, spot)}
              scout={explorer.spotScout}
              fetch={explorer.spotFetch}
              onFetch={(retry) => void explorer.fetchSpot(retry)}
              onRetryScout={explorer.retrySpot}
              onSelect={explorer.selectTarget}
              onBackToSky={() => scrollToSection('dome')}
            />
          </div>
        )}
        {plateTarget && (
          <div className="instrument" id="instrument">
            <TargetBar
              targets={explorer.targets}
              selectedTarget={plateTarget}
              passes={explorer.passesStatus === 'ready' ? passes : null}
              onSelect={explorer.selectTarget}
              onBackToSky={() => scrollToSection('dome')}
            />
            <div className="main-row">
              <div className="plate-column">
                {explorer.passesStatus === 'ready' && (
                  <ViewSwitch
                    view={view}
                    canShowDifference={comparison !== null}
                    onChange={explorer.setView}
                  />
                )}
                <SkyPlate
                  target={plateTarget}
                  passesData={explorer.passesData}
                  passesStatus={explorer.passesStatus}
                  passIndex={explorer.passIndex}
                  band={band}
                  altImage={altImage}
                  onRetry={explorer.retryPasses}
                />
                <PlateCaption
                  target={plateTarget}
                  passesData={explorer.passesData}
                  passIndex={explorer.passIndex}
                  colourKey={explorer.colourKey}
                  band={band}
                  difference={showSpectral ? null : difference}
                  spectral={showSpectral ? spectralLayer : null}
                />
              </div>
              <aside className="side-column" aria-label="Timeframes and colour key">
                {showSpectral && spectralMap ? (
                  <SpectralPanel
                    map={spectralMap}
                    layer={spectralLayer.id}
                    onLayerChange={setSpectralLayerId}
                    onRetry={() => setSpectralAttempt((n) => n + 1)}
                  />
                ) : showDifference && comparison ? (
                  <DifferencePanel
                    key={plateTarget.id}
                    passes={passes}
                    bands={explorer.colourKey.map((c) => c.band)}
                    comparison={comparison}
                    onShow={explorer.setComparison}
                  />
                ) : (
                  <>
                    <TimelinePanel
                      passes={passes}
                      passIndex={explorer.passIndex}
                      isPlaying={explorer.isPlaying}
                      canPlay={framesReady}
                      onSelectPass={explorer.setPassIndex}
                      onPrev={explorer.prev}
                      onNext={explorer.next}
                      onTogglePlay={explorer.togglePlay}
                    />
                    <ColourKeyPanel
                      entries={explorer.colourKey}
                      band={band?.band ?? null}
                      bandsAvailable={bandsAvailable}
                      onBandChange={explorer.setBand}
                    />
                  </>
                )}
              </aside>
            </div>
            <ObservationLog target={plateTarget} passesData={explorer.passesData} />
          </div>
        )}

        <Divider />
        <StorySection onChooseStar={() => scrollToSection('dome')} />
      </main>
    </div>
  )
}
