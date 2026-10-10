// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { Suspense, use, useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { ChangesPaneMount, ComparisonViewMount, HistoryViewMount, Workbench } from "./app/Workbench";
import { createBridge, type BridgeResponse, type OnProgress, type ProgressEvent } from "./bridge";
import { BootView, bootActions, markBootView, type Environment } from "./boot/BootView";
import { createTextScale } from "./layout/text-scale";
import "./index.css";

let sessionChanged = () => {};
// The capability grants no `unlisten`, so the bridge must exist once for the page life, outside React.
const textScale = createTextScale(document.documentElement);
const bridge = createBridge(() => sessionChanged(), textScale.event);
const load = () => ({
  environment: bridge.getEnvironment(),
  hasSession: bridge.currentSession().then((response) => {
    textScale.session(response);
    return response.state === "succeeded";
  }),
});
const firstLoad = load();

// Contract §3 `getEnvironment`: a `gitCode` blocks Git work until Select Git succeeds.
const passed = (response: BridgeResponse) => response.state === "succeeded" && (response.result as Environment).gitCode === undefined;

// The restore starts before the workbench mounts, so its latest progress event waits for the listener.
function restore() {
  let latest: ProgressEvent | null = null;
  let listener: OnProgress | null = null;
  const restored = bridge.restoreWorkspace((event) => {
    latest = event;
    listener?.(event);
  });
  const restoreProgress = (next: OnProgress) => {
    listener = next;
    if (latest !== null) next(latest);
  };
  return { restored, restoreProgress };
}

function App() {
  const [view, setView] = useState(firstLoad);
  const [ready, setReady] = useState<({ environment: Environment } & ReturnType<typeof restore>) | null>(null);
  const [session, setSession] = useState(0);
  const scale = useSyncExternalStore(textScale.subscribe, textScale.current);
  const reload = () => setView(load());
  useEffect(() => {
    sessionChanged = ready === null ? reload : () => setSession((n) => n + 1);
  }, [ready]);
  // plan.md "Marker and frame source": on the pass path, the first rendered view is the workbench. React runs this effect after the workbench commits.
  const workbench = ready !== null;
  useEffect(() => {
    if (workbench) markBootView();
  }, [workbench]);

  if (ready !== null) {
    // A new environment read keeps the workbench while the checks pass. A blocked result returns to the boot view.
    const onEnvironment = (response: BridgeResponse) => {
      if (passed(response)) setReady({ ...ready, environment: response.result as Environment });
      else {
        setReady(null);
        setView(load());
      }
    };
    const selectGit = () =>
      void bridge
        .chooseGit()
        .then(() => bridge.getEnvironment())
        .then(onEnvironment);
    return (
      <Workbench
        bridge={bridge}
        environment={ready.environment}
        restored={ready.restored}
        restoreProgress={ready.restoreProgress}
        session={session}
        onSelectGit={selectGit}
        onEnvironment={onEnvironment}
        ChangesPane={ChangesPaneMount}
        ComparisonView={ComparisonViewMount}
        HistoryView={HistoryViewMount}
        textScale={scale}
      />
    );
  }
  return (
    <Suspense fallback={<BootView state="loading" />}>
      <Boot view={view} reload={reload} onPass={(environment) => setReady({ environment, ...restore() })} />
    </Suspense>
  );
}

function Boot({ view, reload, onPass }: { view: { environment: Promise<BridgeResponse>; hasSession: Promise<boolean> }; reload: () => void; onPass: (environment: Environment) => void }) {
  const result = use(view.environment);
  const session = use(view.hasSession);
  const pass = passed(result);
  useLayoutEffect(() => {
    if (pass) onPass(result.result as Environment);
  }, [pass, result]);
  if (pass) return null;
  if (result.state !== "succeeded") return <BootView state="unavailable" code={result.code ?? result.state} session={session} />;
  return <BootView state="facts" environment={result.result as Environment} {...bootActions(bridge, reload)} />;
}

createRoot(document.getElementById("root")!).render(<App />);
