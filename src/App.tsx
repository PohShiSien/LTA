import { useEffect, useState } from 'react';
import Landing from './pages/Landing';
import SubsystemWorkspace, { type ImportJob } from './pages/SubsystemWorkspace';
import GuidedTour from './components/tour/GuidedTour';
import { markTourComplete } from './components/tour/tourStorage';
import type { Subsystem } from './types/multisystem';

export default function App() {
  const isWorkspaceRoute = () => ['door', 'acv', 'rail', 'shm'].includes(location.hash.slice(1));
  const [entered, setEntered] = useState(isWorkspaceRoute);
  const [visibleSubsystems, setVisibleSubsystems] = useState<Subsystem[] | null>(null);
  const [importJobs, setImportJobs] = useState<ImportJob[] | null>(null);
  const [homeKey, setHomeKey] = useState(0);
  const [tourActive, setTourActive] = useState(false);
  const [tourStep, setTourStep] = useState(0);

  const handleAnalyze = (jobs: ImportJob[]) => {
    if (!jobs.length) return;
    setVisibleSubsystems(jobs.map(job => job.subsystem));
    setImportJobs(jobs);
    location.hash = jobs[0].subsystem;
    setEntered(true);
  };
  const goHome = () => {
    setVisibleSubsystems(null);
    setImportJobs(null);
    location.hash = '';
    setEntered(false);
    setHomeKey(key => key + 1);
    window.scrollTo({ top: 0, behavior: 'instant' });
  };
  useEffect(() => {
    const navigate = () => {
      const workspace = isWorkspaceRoute();
      setEntered(workspace);
      if (!workspace) { setImportJobs(null); setVisibleSubsystems(null); }
    };
    addEventListener('hashchange', navigate);
    return () => removeEventListener('hashchange', navigate);
  }, []);
  // The tour always starts from a clean Home, whether launched from Landing or from an in-progress workspace session.
  const startTour = () => { goHome(); setTourActive(true); setTourStep(0); };
  const changeTourStep = (step: number) => {
    if (step < 3) goHome();
    else { location.hash = 'door'; setEntered(true); }
    setTourStep(step);
  };
  // The tour uses empty live controls; it never generates or imports model results.
  const endTour = () => { setTourActive(false); markTourComplete(); goHome(); };

  return <>
    {!entered
      ? <Landing key={homeKey} onAnalyze={handleAnalyze} onStartTour={startTour} />
      : <SubsystemWorkspace
          visibleSubsystems={visibleSubsystems ?? undefined}
          importJobs={importJobs ?? undefined}
          onBackToUpload={goHome}
          onOpenTour={startTour}
        />}
    {tourActive && <GuidedTour
      step={tourStep}
      onStepChange={changeTourStep}
      onFinish={endTour}
      onSkip={endTour}
    />}
  </>;
}
