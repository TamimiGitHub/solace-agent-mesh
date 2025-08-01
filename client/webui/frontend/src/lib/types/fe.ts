/* eslint-disable @typescript-eslint/no-explicit-any */

import type { LucideIcon } from "lucide-react";

export interface A2AEventSSEPayload {
    event_type: "a2a_message" | string;
    timestamp: string; // ISO 8601
    solace_topic: string;
    direction: "request" | "response" | "status_update" | "artifact_update" | "discovery" | string;
    source_entity: string;
    target_entity: string;
    message_id?: string | null; // JSON-RPC ID
    task_id?: string | null; // A2A Task ID
    payload_summary: {
        method?: string;
        params_preview?: string;
    };
    full_payload: Record<string, any>; // The full A2A JSON-RPC message or other payload
}

export interface TaskFE {
    taskId: string;
    initialRequestText: string; // Truncated text from the first 'request' event
    events: A2AEventSSEPayload[]; // Ordered list of raw SSE event payloads
    firstSeen: Date;
    lastUpdated: Date;
    parentTaskId?: string | null;
}

export interface TaskStoreState {
    tasks: Record<string, TaskFE>;
    taskOrder: string[]; // Array of taskIds to maintain insertion order or sorted order
}

/**
 * Represents a file attachment returned by the agent.
 */
export interface FileAttachment {
    name: string;
    content?: string; // Base64 encoded content - Made optional for Artifact Panel preview
    mime_type?: string; // Optional MIME type
    last_modified?: string; // ISO 8601 timestamp string
}

/**
 * Represents a tool event in the chat conversation.
 */
export interface ToolEvent {
    toolName: string;
    data: unknown; // The result data from the tool
}

/**
 * Represents a single message in the chat conversation.
 */
export interface MessageFE {
    taskId?: string; // The ID of the task that generated this message
    text?: string;
    isStatusBubble?: boolean; // Added to indicate a temporary status message
    isUser: boolean; // True if the message is from the user, false if from the agent/system
    isStatusMessage?: boolean; // True if this is a temporary status message (e.g., "Agent is thinking")
    isThinkingMessage?: boolean; // Specific flag for the "thinking" status message
    isComplete?: boolean; // ADDED: True if the agent response associated with this message is complete
    isError?: boolean; // ADDED: True if this message represents an error/failure
    files?: FileAttachment[]; // Array of files returned by the agent with this message
    uploadedFiles?: File[]; // Array of files uploaded by the user with this message
    artifactNotification?: {
        // ADDED: For displaying artifact arrival notifications
        name: string;
        version?: number; // Optional: If version info is available from metadata
    };
    toolEvents?: ToolEvent[]; // --- NEW: Array to hold tool call results ---
    metadata?: {
        // Optional metadata, e.g., for feedback or correlation
        messageId?: string; // Unique ID for the agent's message (if provided by backend)
        sessionId?: string; // The A2A session ID associated with this message exchange
        lastProcessedEventSequence?: number; // Sequence number of the last SSE event processed for this bubble
    };
}

export interface Notification {
    id: string; // Unique ID for transition key
    message: string;
    type?: "success" | "info" | "error";
}

// Layout Types

export const LayoutType = {
    GRID: "grid",
    HIERARCHICAL: "hierarchical",
    AUTO: "auto",
    CARDS: "cards",
} as const;

export type LayoutType = (typeof LayoutType)[keyof typeof LayoutType];

export interface LayoutConfig {
    type: string | LayoutType;
    spacing: {
        horizontal: number;
        vertical: number;
    };
    viewport: {
        width: number;
        height: number;
    };
    padding: number;
}

export interface CommunicationEdgeData extends Record<string, unknown> {
    communicationType: "bidirectional" | "unidirectional";
    sourceHandle?: string;
    targetHandle?: string;
}

export interface AgentNodeData extends Record<string, unknown> {
    label: string;
    agentName: string;
    status: "online" | "offline";
    description?: string;
}

// Navigation Types

export interface NavigationItem {
    id: string;
    label: string;
    icon: LucideIcon;
    onClick?: () => void;
    path?: string;
    active?: boolean;
    disabled?: boolean;
    showDividerAfter?: boolean;
}

export interface NavigationConfig {
    items: NavigationItem[];
    bottomItems?: NavigationItem[];
}

export interface NavigationContextValue {
    activeItem: string | null;
    setActiveItem: (itemId: string) => void;
    items: NavigationItem[];
    setItems: (items: NavigationItem[]) => void;
}
