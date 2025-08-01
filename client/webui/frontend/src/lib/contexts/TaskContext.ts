import { createContext } from "react";

import type { TaskFE } from "@/lib/types";

interface TaskState {
    isTaskMonitorConnecting: boolean;
    isTaskMonitorConnected: boolean;
    taskMonitorSseError: string | null;
    monitoredTasks: Record<string, TaskFE>;
    monitoredTaskOrder: string[];
    highlightedStepId: string | null;
    isReplaying: boolean;
    currentReplayStep: number;
    isReconnecting: boolean;
    reconnectionAttempts: number;
}

interface TaskActions {
    connectTaskMonitorStream: () => Promise<void>;
    disconnectTaskMonitorStream: () => Promise<void>;
    setHighlightedStepId: (stepId: string | null) => void;
    setReplayState: (isReplaying: boolean, currentStep: number) => void;
}

export type TaskContextValue = TaskState & TaskActions;

export const TaskContext = createContext<TaskContextValue | undefined>(undefined);
