import { useState } from 'react';
import Landing from './pages/Landing';
import SubsystemWorkspace, { type ImportJob } from './pages/SubsystemWorkspace';
import GuidedTour from './components/tour/GuidedTour';
import { markTourComplete } from './components/tour/tourStorage';
import type { Subsystem } from './types/multisystem';

export default function App() {
  const [entered, setEntered] = useState(() => Boolean(location.hash.slice(1)));
  const [visibleSubsystems, setVisibleSubsystems] = useState<Subsystem[] | null>(null);
  const [importJobs, setImportJobs] = useState<ImportJob[] | null>(null);
  const [demoMode, setDemoMode] = useState(false);
  const [tourActive, setTourActive] = useState(false);
  const [tourStep, setTourStep] = useState(0);

  const handleAnalyze = (jobs: ImportJob[]) => {
    setVisibleSubsystems(jobs.map(job => job.subsystem));
    setImportJobs(jobs);
    setDemoMode(false);
    setEntered(true);
  };
  const goHome = () => {
    setVisibleSubsystems(null);
    setImportJobs(null);
    setDemoMode(false);
    location.hash = '';
    setEntered(false);
  };
  // The tour always starts from a clean Home, whether launched from Landing or from an in-progress workspace session.
  const startTour = () => { goHome(); setTourActive(true); setTourStep(0); };
  const enterWorkspaceDemo = () => { setDemoMode(true); setVisibleSubsystems(null); setImportJobs(null); location.hash = 'door'; setEntered(true); };
  // The tour is only ever a demonstration: finishing or skipping it clears the demo session and returns Home.
  const endTour = () => { setTourActive(false); markTourComplete(); goHome(); };

  return <>
    {!entered
      ? <Landing onAnalyze={handleAnalyze} onStartDemo={startTour} />
      : <SubsystemWorkspace
          visibleSubsystems={visibleSubsystems ?? undefined}
          importJobs={importJobs ?? undefined}
          initialMode={demoMode ? 'demo' : undefined}
          onBackToUpload={goHome}
          onOpenTour={startTour}
        />}
    {tourActive && <GuidedTour
      step={tourStep}
      onStepChange={setTourStep}
      onEnterWorkspaceDemo={enterWorkspaceDemo}
      onFinish={endTour}
      onSkip={endTour}
    />}
  </>;
}
