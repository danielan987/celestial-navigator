import { useEffect } from 'react'
import DomeHero from './components/DomeHero'
import Divider from './components/Divider'
import TargetBar from './components/TargetBar'
import SkyPlate from './components/SkyPlate'
import PlateCaption from './components/PlateCaption'
import TimelinePanel from './components/TimelinePanel'
import ColourKeyPanel from './components/ColourKeyPanel'
import DifferencePanel from './components/DifferencePanel'
import ViewSwitch from './components/ViewSwitch'
import ObservationLog from './components/ObservationLog'
import StorySection from './components/StorySection'
import UnchartedSpot from './components/UnchartedSpot'
import { defaultComparison, nearestTarget, spotAsTarget, useExplorer } from './hooks/useExplorer'
import { useDifferenceImage } from './hooks/useDifferenceImage'
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
                    view={showDifference ? 'difference' : 'blink'}
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
                  difference={
                    difference && differenceImage
                      ? {
                          image: differenceImage,
                          label: `${difference.from.label} → ${difference.to.label}`,
                          band: difference.band,
                        }
                      : null
                  }
                  onRetry={explorer.retryPasses}
                />
                <PlateCaption
                  target={plateTarget}
                  passesData={explorer.passesData}
                  passIndex={explorer.passIndex}
                  colourKey={explorer.colourKey}
                  band={band}
                  difference={difference}
                />
              </div>
              <aside className="side-column" aria-label="Timeframes and colour key">
                {showDifference && comparison ? (
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
