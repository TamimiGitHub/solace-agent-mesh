/* eslint-disable @typescript-eslint/no-explicit-any */
import type {
  A2AEventSSEPayload,
  AgentPerformanceMetrics,
  Artifact,
  ArtifactNotificationData,
  DataPart,
  DelegationInfo,
  FilePart,
  JSONRPCError,
  LLMCallData,
  LLMResponseToAgentData,
  PerformanceReport,
  TaskFE,
  TaskState,
  TextPart,
  ToolCallPerformance,
  ToolDecision,
  ToolDecisionData,
  ToolInvocationStartData,
  ToolResultData,
  VisualizerStep,
  VisualizerStepType,
  VisualizedTask
} from "@/lib/types";


/**
 * Helper function to get parentTaskId from a TaskFE object.
 * It first checks the direct `parentTaskId` field. If not present,
 * it attempts to infer it from the task's first event metadata.
 *
 * @param task The TaskFE object.
 * @returns The parentTaskId string, or null/undefined if not found.
 */
const getParentTaskIdFromTaskObject = (task: TaskFE): string | null | undefined => {
    // Infer from the first event if not set on the task object
    if (task.events && task.events.length > 0) {
        const firstEvent = task.events[0];
        // Typically, the first event for a sub-task is a 'request' event containing parentTaskId in its metadata
        if (firstEvent.full_payload?.params?.metadata?.parentTaskId) {
            return firstEvent.full_payload.params.metadata.parentTaskId;
        }
    }
    return undefined;
};

const findAgentNameForTask = (taskId: string, allTasks: Record<string, TaskFE>): string | null => {
    const task = allTasks[taskId];
    if (!task) return null;
    // Try to find the agent name from the events, as it's the most reliable source
    for (const event of task.events || []) {
        const payload = event.full_payload;
        if (event.direction === "status_update" && payload?.result) {
            const agentName = payload.result.metadata?.agent_name || payload.result.status?.message?.metadata?.agent_name || event.source_entity;
            if (agentName) return agentName;
        }
    }
    // Fallback to target_entity of the initial request
    const requestEvent = task.events?.find(e => e.direction === "request");
    return requestEvent?.target_entity || null;
};

const getEventTimestamp = (event: A2AEventSSEPayload): string => {
    return event.full_payload?.result?.status?.timestamp || event.timestamp;
};

/**
 * Recursively collects all events for a given task and all its descendant sub-tasks.
 * Also populates a map with the nesting level of each task.
 *
 * @param currentTaskId The ID of the task to start collecting from.
 * @param allMonitoredTasks A record of all monitored tasks.
 * @param taskNestingLevels A map to store the nesting level of each task ID.
 * @param currentLevel The current nesting level for currentTaskId.
 * @returns An array of A2AEventSSEPayload objects from the task and its descendants.
 */
const collectAllDescendantEvents = (currentTaskId: string, allMonitoredTasks: Record<string, TaskFE>, taskNestingLevels: Map<string, number>, currentLevel: number): A2AEventSSEPayload[] => {
    const task = allMonitoredTasks[currentTaskId];
    if (!task) {
        console.warn(`[collectAllDescendantEvents] Task not found in allMonitoredTasks: ${currentTaskId}`);
        return [];
    }

    taskNestingLevels.set(currentTaskId, currentLevel);
    let events: A2AEventSSEPayload[] = [...(task.events || [])];

    // Find and process direct children
    for (const taskIdInStore in allMonitoredTasks) {
        const potentialChildTask = allMonitoredTasks[taskIdInStore];
        if (potentialChildTask.taskId === currentTaskId) continue;

        // Use the helper to get parentTaskId, preferring the direct field but falling back to event inspection
        const childsParentId = getParentTaskIdFromTaskObject(potentialChildTask);

        if (childsParentId === currentTaskId) {
            events = events.concat(collectAllDescendantEvents(potentialChildTask.taskId, allMonitoredTasks, taskNestingLevels, currentLevel + 1));
        }
    }
    return events;
};

/**
 * Processes raw A2A SSE events for a task and transforms them into a sequence of
 * logical visualizer steps, including duration calculations.
 *
 * @param _rawEventsForParentTask - An array of A2AEventSSEPayload objects for the primary task (now unused, events are fetched via parentTaskObject and collectAllDescendantEvents).
 * @param allMonitoredTasks - A record of all monitored tasks, used to find sub-task events.
 * @param parentTaskObject - The TaskFE object for the primary task being visualized.
 * @returns A VisualizedTask object containing all processed steps and task-level timing, or null if no data.
 */
export const processTaskForVisualization = (
    _rawEventsForParentTask: A2AEventSSEPayload[], // Parameter kept for signature compatibility, but not directly used for initial event set.
    allMonitoredTasks: Record<string, TaskFE>,
    parentTaskObject: TaskFE | null
): VisualizedTask | null => {
    if (!parentTaskObject) {
        return null;
    }

    // --- Performance Report Initialization ---
    const report: PerformanceReport = {
        overall: { totalTaskDurationMs: 0 },
        agents: {},
    };

    const inProgressLlmCalls = new Map<string, { timestamp: string; modelName: string }>(); // Key: agentInstanceId
    const inProgressToolCalls = new Map<
        string,
        {
            timestamp: string;
            toolName: string;
            isPeer: boolean;
            invokingAgentInstanceId: string;
            subTaskId?: string;
            parallelBlockId?: string;
        }
    >(); // Key: functionCallId

    const ensureAgentMetrics = (instanceId: string, agentName: string): AgentPerformanceMetrics => {
        if (!report.agents[instanceId]) {
            report.agents[instanceId] = {
                agentName,
                instanceId,
                displayName: agentName, // Temporary, will be updated in phase 2
                llmCalls: [],
                toolCalls: [],
                totalLlmTimeMs: 0,
                totalToolTimeMs: 0,
            };
        }
        return report.agents[instanceId];
    };
    // --- End Performance Report Initialization ---

    const taskNestingLevels = new Map<string, number>();

    const combinedEvents = collectAllDescendantEvents(
        parentTaskObject.taskId,
        allMonitoredTasks,
        taskNestingLevels,
        0 // Root task is at level 0
    );

    if (combinedEvents.length === 0) {
        return {
            taskId: parentTaskObject.taskId,
            initialRequestText: parentTaskObject.initialRequestText,
            status: "working", // Or derive from parentTaskObject if it has a status
            startTime: parentTaskObject.firstSeen.toISOString(),
            steps: [],
        } as unknown as VisualizedTask;
    }

    // 2. Sort all collected events by timestamp
    const sortedEvents = combinedEvents.sort((a, b) => new Date(getEventTimestamp(a)).getTime() - new Date(getEventTimestamp(b)).getTime());

    const visualizerSteps: VisualizerStep[] = [];
    let currentAggregatedText = "";
    let aggregatedTextSourceAgent: string | undefined = undefined;
    let aggregatedTextTimestamp: string | undefined = undefined;
    let aggregatedRawEventIds: string[] = [];
    let lastFlushedAgentResponseText: string | null = null;
    let aggregatedTextIsForwardedContext: boolean | undefined = undefined;

    // State for duration calculation
    const subTaskToFunctionCallIdMap = new Map<string, string>();
    const functionCallIdToDelegationInfoMap = new Map<string, DelegationInfo>();
    const activeFunctionCallIdByTask = new Map<string, string>();

    const flushAggregatedTextStep = (currentEventOwningTaskId?: string) => {
        if (currentAggregatedText.trim() && aggregatedTextSourceAgent && aggregatedTextTimestamp) {
            const textToFlush = currentAggregatedText.trim();

            let owningTaskIdForFlush = parentTaskObject.taskId;
            if (aggregatedRawEventIds.length > 0) {
                const parts = aggregatedRawEventIds[0].split("-");
                if (parts.length > 2 && parts[1] !== "global") {
                    owningTaskIdForFlush = parts.slice(1, parts.length - 1).join("-");
                }
            } else if (currentEventOwningTaskId) {
                owningTaskIdForFlush = currentEventOwningTaskId;
            }

            const nestingLevelForFlush = taskNestingLevels.get(owningTaskIdForFlush) ?? 0;
            const functionCallIdForStep = subTaskToFunctionCallIdMap.get(owningTaskIdForFlush) || activeFunctionCallIdByTask.get(owningTaskIdForFlush);

            visualizerSteps.push({
                id: `vstep-agenttext-${visualizerSteps.length}-${aggregatedRawEventIds[0] || "unknown"}`,
                type: "AGENT_RESPONSE_TEXT",
                timestamp: aggregatedTextTimestamp,
                title: `${aggregatedTextSourceAgent}: Response`,
                source: aggregatedTextSourceAgent,
                target: "User",
                data: { text: textToFlush },
                rawEventIds: [...aggregatedRawEventIds],
                isSubTaskStep: nestingLevelForFlush > 0,
                nestingLevel: nestingLevelForFlush,
                owningTaskId: owningTaskIdForFlush,
                functionCallId: functionCallIdForStep,
            });
            lastFlushedAgentResponseText = textToFlush;
        }
        currentAggregatedText = "";
        aggregatedTextSourceAgent = undefined;
        aggregatedTextTimestamp = undefined;
        aggregatedRawEventIds = [];
        aggregatedTextIsForwardedContext = undefined;
    };

    // 3. Process the sorted, combined event stream
    sortedEvents.forEach((event, index) => {
        const eventTimestamp = getEventTimestamp(event);
        const eventId = `raw-${event.task_id || "global"}-${index}`;
        const payload = event.full_payload;
        const currentEventOwningTaskId = event.task_id || parentTaskObject.taskId;
        const currentEventNestingLevel = taskNestingLevels.get(currentEventOwningTaskId) ?? 0;

        // Determine agent name
        let eventAgentName = event.source_entity || "UnknownAgent";
        if (payload?.result?.metadata?.agent_name) {
            eventAgentName = payload.result.metadata.agent_name;
        } else if (payload?.result?.status?.message?.metadata?.agent_name) {
            eventAgentName = payload.result.status.message.metadata.agent_name;
        } else if (payload?.result?.artifact?.metadata?.agent_name) {
            eventAgentName = payload.result.artifact.metadata.agent_name;
        }

        // Determine functionCallId for the step
        let functionCallIdForStep: string | undefined;
        const metadataFunctionCallId = (payload?.result?.status?.message?.metadata as any)?.function_call_id;

        if (currentEventNestingLevel > 0) {
            functionCallIdForStep = subTaskToFunctionCallIdMap.get(currentEventOwningTaskId);
        } else {
            functionCallIdForStep = activeFunctionCallIdByTask.get(currentEventOwningTaskId);
        }

        if (metadataFunctionCallId) {
            functionCallIdForStep = metadataFunctionCallId;
        }

        // Handle sub-task creation requests to establish the mapping early
        if (event.direction === "request" && currentEventNestingLevel > 0) {
            const metadata = payload.params?.metadata as any;
            const functionCallId = metadata?.function_call_id;
            const subTaskId = event.task_id;

            if (subTaskId && functionCallId) {
                subTaskToFunctionCallIdMap.set(subTaskId, functionCallId);
                // This event's only purpose is to create the mapping.
                // It doesn't create a visual step itself, so we return.
                return;
            }
        }

        // USER REQUEST (for root task only)
        if (event.direction === "request" && currentEventNestingLevel === 0 && event.task_id === parentTaskObject.taskId) {
            flushAggregatedTextStep(currentEventOwningTaskId);
            lastFlushedAgentResponseText = null;
            const params = payload.params as any;
            let userText = "User request";
            if (params?.message?.parts) {
                // const textPart = params.message.parts.find((p: any) => p.type === "text") as TextPart | undefined;
                // if (textPart?.text) userText = textPart.text;

                // This is a temporary workaround before BE has a better way to inject timestamps without confusing user input
                const textParts = params.message.parts.filter((p: any) => p.type === "text") as TextPart[];
                userText = textParts[1]?.text ?? textParts[0]?.text;
            }
            visualizerSteps.push({
                id: `vstep-userreq-${visualizerSteps.length}-${eventId}`,
                type: "USER_REQUEST",
                timestamp: eventTimestamp,
                title: "User Input",
                source: "User",
                target: event.target_entity || eventAgentName,
                data: { text: userText },
                rawEventIds: [eventId],
                isSubTaskStep: false,
                nestingLevel: 0,
                owningTaskId: currentEventOwningTaskId,
            });
            return;
        }

        // Any status_update with a result
        if (event.direction === "status_update" && payload?.result) {
            const result = payload.result as any;
            const statusMessage = result.status?.message;
            const messageMetadata = statusMessage?.metadata as any;

            let statusUpdateAgentName: string;
            let isForwardedMessage = false;
            if (messageMetadata?.forwarded_from_peer) {
                statusUpdateAgentName = messageMetadata.forwarded_from_peer;
                isForwardedMessage = true;
            } else if (result.metadata?.agent_name) {
                statusUpdateAgentName = result.metadata.agent_name;
            } else if (messageMetadata?.agent_name) {
                statusUpdateAgentName = messageMetadata.agent_name;
            } else {
                statusUpdateAgentName = event.source_entity || "Agent";
            }
            const agentInstanceId = `${statusUpdateAgentName}:${currentEventOwningTaskId}`;

            // LLM INVOCATION -> AGENT_LLM_CALL
            if (messageMetadata?.type === "llm_invocation") {
                flushAggregatedTextStep(currentEventOwningTaskId);
                const llmData = messageMetadata.data as any;
                let promptText = "System-initiated LLM call";
                if (llmData?.contents && Array.isArray(llmData.contents)) {
                    for (let i = llmData.contents.length - 1; i >= 0; i--) {
                        const contentPart = llmData.contents[i];
                        if (contentPart?.role === "user") {
                            if (contentPart.parts?.some((p: any) => p.text)) {
                                promptText = contentPart.parts.map((p: any) => p.text).join("\n");
                                break;
                            } else if (contentPart.parts?.some((p: any) => p.function_response)) {
                                const funcResponsePart = contentPart.parts.find((p: any) => p.function_response);
                                promptText = `Processing response from tool: ${funcResponsePart.function_response.name}`;
                                break;
                            }
                        }
                    }
                }
                const llmCallData: LLMCallData = {
                    modelName: llmData?.model || "Unknown Model",
                    promptPreview: promptText,
                };

                // --- Performance Data Collection ---
                ensureAgentMetrics(agentInstanceId, statusUpdateAgentName);
                inProgressLlmCalls.set(agentInstanceId, {
                    timestamp: eventTimestamp,
                    modelName: llmCallData.modelName,
                });
                // ---

                const llmCallStep: VisualizerStep = {
                    id: `vstep-llmcall-${visualizerSteps.length}-${eventId}`,
                    type: "AGENT_LLM_CALL",
                    timestamp: eventTimestamp,
                    title: `${statusUpdateAgentName}: LLM Call`,
                    source: statusUpdateAgentName,
                    target: "LLM",
                    data: { llmCall: llmCallData },
                    rawEventIds: [eventId],
                    isSubTaskStep: currentEventNestingLevel > 0,
                    nestingLevel: currentEventNestingLevel,
                    owningTaskId: currentEventOwningTaskId,
                    functionCallId: functionCallIdForStep,
                };
                visualizerSteps.push(llmCallStep);
                return;
            }

            // LLM RESPONSE -> TOOL DECISION or forward
            if (messageMetadata?.type === "llm_response" && messageMetadata.data?.content?.parts) {
                // --- Performance Data Collection ---
                const openCallForPerf = inProgressLlmCalls.get(agentInstanceId);
                if (openCallForPerf) {
                    const duration = new Date(eventTimestamp).getTime() - new Date(openCallForPerf.timestamp).getTime();
                    const agentMetrics = ensureAgentMetrics(agentInstanceId, statusUpdateAgentName);
                    agentMetrics.llmCalls.push({
                        modelName: openCallForPerf.modelName,
                        durationMs: duration,
                        timestamp: openCallForPerf.timestamp,
                    });
                    inProgressLlmCalls.delete(agentInstanceId);
                }
                // ---

                const contentParts = messageMetadata.data.content.parts as any[];
                const functionCallParts = contentParts.filter(p => p.function_call);
                if (functionCallParts.length > 0) {
                    if (aggregatedTextSourceAgent === statusUpdateAgentName && currentAggregatedText.trim()) {
                        flushAggregatedTextStep(currentEventOwningTaskId);
                        lastFlushedAgentResponseText = null;
                    }

                    activeFunctionCallIdByTask.delete(currentEventOwningTaskId);

                    const decisions: ToolDecision[] = functionCallParts.map(part => {
                        const funcCall = part.function_call;
                        return {
                            functionCallId: funcCall.id,
                            toolName: funcCall.name,
                            toolArguments: funcCall.args || {},
                            isPeerDelegation: funcCall.name?.startsWith("peer_"),
                        };
                    });

                    const toolDecisionData: ToolDecisionData = {
                        decisions: decisions,
                        isParallel: decisions.length > 1,
                    };

                    const delegationInfos: DelegationInfo[] = [];
                    const claimedSubTaskIds = new Set<string>();
                    decisions.forEach(decision => {
                        if (decision.isPeerDelegation) {
                            const peerAgentActualName = decision.toolName.substring(5);
                            for (const stId in allMonitoredTasks) {
                                const candSubTask = allMonitoredTasks[stId];
                                if (claimedSubTaskIds.has(candSubTask.taskId)) continue;

                                const candSubTaskParentId = getParentTaskIdFromTaskObject(candSubTask);

                                if (candSubTaskParentId === currentEventOwningTaskId && candSubTask.events && candSubTask.events.length > 0) {
                                    const subTaskCreationRequest = candSubTask.events.find(e => e.direction === "request" && e.full_payload?.method?.startsWith("tasks/") && e.target_entity === peerAgentActualName);
                                    if (subTaskCreationRequest && new Date(getEventTimestamp(subTaskCreationRequest)).getTime() >= new Date(eventTimestamp).getTime()) {
                                        const delInfo: DelegationInfo = {
                                            functionCallId: decision.functionCallId,
                                            peerAgentName: peerAgentActualName,
                                            subTaskId: candSubTask.taskId,
                                        };
                                        delegationInfos.push(delInfo);
                                        functionCallIdToDelegationInfoMap.set(decision.functionCallId, delInfo);
                                        if (candSubTask.taskId) {
                                            subTaskToFunctionCallIdMap.set(candSubTask.taskId, decision.functionCallId);
                                            claimedSubTaskIds.add(candSubTask.taskId);
                                        }
                                        break;
                                    }
                                }
                            }
                        }
                    });

                    const toolDecisionStep: VisualizerStep = {
                        id: `vstep-tooldecision-${visualizerSteps.length}-${eventId}`,
                        type: "AGENT_LLM_RESPONSE_TOOL_DECISION",
                        timestamp: eventTimestamp,
                        title: `LLM: Tool Decision${toolDecisionData.isParallel ? " (Parallel)" : ""}`,
                        source: "LLM",
                        target: statusUpdateAgentName,
                        data: { toolDecision: toolDecisionData },
                        rawEventIds: [eventId],
                        delegationInfo: delegationInfos.length > 0 ? delegationInfos : undefined,
                        isSubTaskStep: currentEventNestingLevel > 0,
                        nestingLevel: currentEventNestingLevel,
                        owningTaskId: currentEventOwningTaskId,
                    };
                    visualizerSteps.push(toolDecisionStep);

                    const parallelBlockId = toolDecisionData.isParallel ? toolDecisionStep.id : undefined;

                    // --- Performance Data Collection: Start timers for all decided tool calls ---
                    const invokingAgentInstanceId = agentInstanceId;
                    ensureAgentMetrics(invokingAgentInstanceId, statusUpdateAgentName);

                    decisions.forEach(decision => {
                        const subTaskId = decision.isPeerDelegation ? functionCallIdToDelegationInfoMap.get(decision.functionCallId)?.subTaskId : undefined;

                        // Don't add if it's already being tracked (should not happen, but safe)
                        if (!inProgressToolCalls.has(decision.functionCallId)) {
                            inProgressToolCalls.set(decision.functionCallId, {
                                timestamp: eventTimestamp, // Start timer at the moment of decision
                                toolName: decision.toolName,
                                isPeer: decision.isPeerDelegation,
                                invokingAgentInstanceId: invokingAgentInstanceId,
                                subTaskId: subTaskId,
                                parallelBlockId: parallelBlockId,
                            });
                        }
                    });
                    // ---
                    return;
                } else {
                    const llmResponseText = contentParts
                        .filter(p => p.text)
                        .map(p => p.text)
                        .join("\\n");

                    const llmResponseToAgentData: LLMResponseToAgentData = {
                        responsePreview: llmResponseText.substring(0, 200) + (llmResponseText.length > 200 ? "..." : ""),
                        isFinalResponse: messageMetadata.data?.partial === false,
                    };

                    visualizerSteps.push({
                        id: `vstep-llmrespagent-${visualizerSteps.length}-${eventId}`,
                        type: "AGENT_LLM_RESPONSE_TO_AGENT",
                        timestamp: eventTimestamp,
                        title: `${statusUpdateAgentName}: LLM Response`,
                        source: "LLM",
                        target: statusUpdateAgentName,
                        data: { llmResponseToAgent: llmResponseToAgentData },
                        rawEventIds: [eventId],
                        isSubTaskStep: currentEventNestingLevel > 0,
                        nestingLevel: currentEventNestingLevel,
                        owningTaskId: currentEventOwningTaskId,
                        functionCallId: functionCallIdForStep,
                    });
                    return;
                }
            }

            // TOOL INVOCATION START
            if (messageMetadata?.type === "tool_invocation_start") {
                if (aggregatedTextSourceAgent === statusUpdateAgentName && currentAggregatedText.trim()) {
                    flushAggregatedTextStep(currentEventOwningTaskId);
                    lastFlushedAgentResponseText = null;
                }
                const toolInvocationData = messageMetadata.data;
                const toolName = toolInvocationData?.tool_name;
                const toolArgs = toolInvocationData?.tool_args || {};

                // FIX: Directly use the function_call_id from the event payload.
                // The previous logic was brittle and failed for nested/parallel tool calls.
                const functionCallId = toolInvocationData?.function_call_id || `unknown-${toolName}-${visualizerSteps.length}`;
                console.log(`Processing tool invocation start for ${toolName} with functionCallId: ${functionCallId}`);

                const invocationData: ToolInvocationStartData = {
                    functionCallId: functionCallId,
                    toolName: toolName,
                    toolArguments: toolArgs,
                    isPeerInvocation: toolName?.startsWith("peer_"),
                };

                // --- Performance Data Collection (Timer started at TOOL_DECISION step) ---

                const toolInvocationStep: VisualizerStep = {
                    id: `vstep-toolinvokestart-${visualizerSteps.length}-${eventId}`,
                    type: "AGENT_TOOL_INVOCATION_START",
                    timestamp: eventTimestamp,
                    title: `${statusUpdateAgentName}: Executing tool ${toolName}`,
                    source: statusUpdateAgentName,
                    target: toolName,
                    data: { toolInvocationStart: invocationData },
                    rawEventIds: [eventId],
                    isSubTaskStep: currentEventNestingLevel > 0,
                    nestingLevel: currentEventNestingLevel,
                    owningTaskId: currentEventOwningTaskId,
                    functionCallId: functionCallId,
                };
                if (invocationData.isPeerInvocation) {
                    const delInfo = functionCallIdToDelegationInfoMap.get(functionCallId);
                    if (delInfo) {
                        toolInvocationStep.delegationInfo = [delInfo];
                    }
                }
                visualizerSteps.push(toolInvocationStep);

                return;
            }

            // TOOL RESPONSE CONTENT
            if (statusMessage?.parts) {
                if (messageMetadata?.type === "tool_response_content") {
                    flushAggregatedTextStep(currentEventOwningTaskId);

                    // A "tool_response_content" message can contain multiple DataParts, one for each parallel
                    // tool call that has completed. Each DataPart has its own metadata with tool_name and function_call_id.
                    const toolResultParts = (result.status?.message?.parts?.filter((p: any) => p.type === "data" && p.metadata?.tool_name) || []) as DataPart[];

                    toolResultParts.forEach((part, partIndex) => {
                        const partMetadata = part.metadata as any; // Cast for easier access
                        const toolName = partMetadata.tool_name;
                        const functionCallId = partMetadata.function_call_id;

                        if (!toolName || !functionCallId) {
                            console.warn("Skipping tool result part due to missing metadata", part);
                            return;
                        }

                        // --- Performance Data Collection ---
                        const openToolCallForPerf = inProgressToolCalls.get(functionCallId);
                        if (openToolCallForPerf) {
                            const duration = new Date(eventTimestamp).getTime() - new Date(openToolCallForPerf.timestamp).getTime();
                            const invokingAgentMetrics = report.agents[openToolCallForPerf.invokingAgentInstanceId];
                            if (invokingAgentMetrics) {
                                const toolCallPerf: ToolCallPerformance = {
                                    toolName: openToolCallForPerf.toolName,
                                    durationMs: duration,
                                    isPeer: openToolCallForPerf.isPeer,
                                    timestamp: openToolCallForPerf.timestamp,
                                    peerAgentName: openToolCallForPerf.isPeer ? openToolCallForPerf.toolName.substring(5) : undefined,
                                    subTaskId: openToolCallForPerf.subTaskId,
                                    parallelBlockId: openToolCallForPerf.parallelBlockId,
                                };
                                invokingAgentMetrics.toolCalls.push(toolCallPerf);
                            }
                            inProgressToolCalls.delete(functionCallId);
                        }
                        // ---

                        const isPeerResp = toolName?.startsWith("peer_");
                        const toolResultData: ToolResultData = {
                            toolName: toolName,
                            functionCallId: functionCallId,
                            resultData: part.data,
                            isPeerResponse: isPeerResp,
                        };

                        visualizerSteps.push({
                            id: `vstep-toolresult-${visualizerSteps.length}-${eventId}-${partIndex}`,
                            type: "AGENT_TOOL_EXECUTION_RESULT",
                            timestamp: eventTimestamp,
                            title: `${statusUpdateAgentName}: Tool Result - ${toolName}`,
                            source: toolName,
                            target: statusUpdateAgentName,
                            data: { toolResult: toolResultData },
                            rawEventIds: [eventId],
                            isSubTaskStep: currentEventNestingLevel > 0,
                            nestingLevel: currentEventNestingLevel,
                            owningTaskId: currentEventOwningTaskId,
                            functionCallId: functionCallId,
                        });
                    });
                    return;
                }
            }

            // Final text part from a "final: true" status_update event for the root task
            if (result.final === true && currentEventOwningTaskId === parentTaskObject.taskId) {
                flushAggregatedTextStep(currentEventOwningTaskId);
                const statusMsg = result.status?.message;
                if (statusMsg?.parts) {
                    const textPart = statusMsg.parts.find((p: any) => p.type === "text") as TextPart | undefined;
                    if (textPart?.text && textPart.text.trim()) {
                        const finalTextFromThisEvent = textPart.text.trim();
                        if (finalTextFromThisEvent !== lastFlushedAgentResponseText) {
                            visualizerSteps.push({
                                id: `vstep-agenttext-finalevent-${visualizerSteps.length}-${eventId}`,
                                type: "AGENT_RESPONSE_TEXT",
                                timestamp: eventTimestamp,
                                title: `${statusUpdateAgentName}: Response (Final Update)`,
                                source: statusUpdateAgentName,
                                target: "User",
                                data: { text: finalTextFromThisEvent },
                                rawEventIds: [eventId],
                                isSubTaskStep: currentEventNestingLevel > 0,
                                nestingLevel: currentEventNestingLevel,
                                owningTaskId: currentEventOwningTaskId,
                                functionCallId: functionCallIdForStep,
                            });
                            lastFlushedAgentResponseText = finalTextFromThisEvent;
                        }
                    }
                }
                return;
            }

            // Aggregating streaming text
            if (statusMessage?.parts) {
                const textPart = statusMessage.parts.find((part: any) => part.type === "text") as TextPart | undefined;
                if (textPart?.text) {
                    if (aggregatedTextSourceAgent && aggregatedTextSourceAgent !== statusUpdateAgentName) {
                        flushAggregatedTextStep(currentEventOwningTaskId);
                        lastFlushedAgentResponseText = null;
                    }
                    if (!aggregatedTextSourceAgent) {
                        aggregatedTextSourceAgent = statusUpdateAgentName;
                        aggregatedTextTimestamp = eventTimestamp;
                        aggregatedTextIsForwardedContext = isForwardedMessage;
                    }
                    currentAggregatedText += textPart.text;
                    aggregatedRawEventIds.push(eventId);
                } else {
                    const dataPartSignal = statusMessage.parts.find((part: any) => part.type === "data" && (part as DataPart).data?.a2a_signal_type === "agent_status_message") as DataPart | undefined;
                    if (dataPartSignal && isForwardedMessage) {
                        const signalText = dataPartSignal.data?.text;
                        if (signalText) {
                            if (aggregatedTextSourceAgent && aggregatedTextSourceAgent !== statusUpdateAgentName) {
                                flushAggregatedTextStep(currentEventOwningTaskId);
                                lastFlushedAgentResponseText = null;
                            }
                            if (!aggregatedTextSourceAgent) {
                                aggregatedTextSourceAgent = statusUpdateAgentName;
                                aggregatedTextTimestamp = eventTimestamp;
                                aggregatedTextIsForwardedContext = true;
                            }
                            currentAggregatedText += signalText;
                            aggregatedRawEventIds.push(eventId);
                        }
                    }
                }
            }
            return;
        }

        // ARTIFACT UPDATE
        if (event.direction === "artifact_update" && payload?.result?.artifact) {
            flushAggregatedTextStep(currentEventOwningTaskId);
            const artifactData = payload.result.artifact as Artifact;
            const artifactAgentName = artifactData.metadata?.agent_name || event.source_entity || "Agent";
            let mimeType: string | undefined = undefined;
            if (artifactData.parts && artifactData.parts.length > 0) {
                const firstPart = artifactData.parts[0];
                if (firstPart.type === "file") {
                    mimeType = (firstPart as FilePart).file.mimeType || undefined;
                } else if (firstPart.metadata?.mime_type) {
                    mimeType = firstPart.metadata.mime_type;
                }
            }
            const artifactNotification: ArtifactNotificationData = {
                artifactName: artifactData.name || "Unnamed Artifact",
                version: typeof artifactData.metadata?.version === "number" ? artifactData.metadata.version : undefined,
                description: artifactData.description || undefined,
                mimeType,
            };
            visualizerSteps.push({
                id: `vstep-artifactnotify-${visualizerSteps.length}-${eventId}`,
                type: "AGENT_ARTIFACT_NOTIFICATION",
                timestamp: eventTimestamp,
                title: `${artifactAgentName}: Artifact Update - ${artifactNotification.artifactName}`,
                source: artifactAgentName,
                target: "User/System",
                data: { artifactNotification },
                rawEventIds: [eventId],
                isSubTaskStep: currentEventNestingLevel > 0,
                nestingLevel: currentEventNestingLevel,
                owningTaskId: currentEventOwningTaskId,
                functionCallId: functionCallIdForStep,
            });
            return;
        }

        // FINAL RESPONSE / TASK COMPLETION (REPLACE THIS ENTIRE BLOCK)
        if (event.direction === "response" && payload?.result?.status?.state) {
            if (currentAggregatedText.trim()) {
                flushAggregatedTextStep(currentEventOwningTaskId);
            }

            const result = payload.result as any;
            const finalState = result.status.state as string;
            const responseAgentName = result.metadata?.agent_name || result.status?.message?.metadata?.agent_name || event.source_entity || "Agent";

            // Check if this is a sub-task completing and returning to its parent
            if (currentEventNestingLevel > 0 && finalState === "completed") {
                const parentTaskId = getParentTaskIdFromTaskObject(allMonitoredTasks[currentEventOwningTaskId]);
                const parentAgentName = parentTaskId ? findAgentNameForTask(parentTaskId, allMonitoredTasks) : null;
                const functionCallId = subTaskToFunctionCallIdMap.get(currentEventOwningTaskId);

                if (parentAgentName && functionCallId) {
                    // --- Performance Data Collection ---
                    const openToolCallForPerf = inProgressToolCalls.get(functionCallId);
                    if (openToolCallForPerf) {
                        const duration = new Date(eventTimestamp).getTime() - new Date(openToolCallForPerf.timestamp).getTime();
                        const invokingAgentMetrics = report.agents[openToolCallForPerf.invokingAgentInstanceId];
                        if (invokingAgentMetrics) {
                            const toolCallPerf: ToolCallPerformance = {
                                toolName: openToolCallForPerf.toolName,
                                durationMs: duration,
                                isPeer: openToolCallForPerf.isPeer,
                                timestamp: openToolCallForPerf.timestamp,
                                peerAgentName: openToolCallForPerf.isPeer ? openToolCallForPerf.toolName.substring(5) : undefined,
                                subTaskId: openToolCallForPerf.subTaskId,
                                parallelBlockId: openToolCallForPerf.parallelBlockId,
                            };
                            invokingAgentMetrics.toolCalls.push(toolCallPerf);
                        }
                        inProgressToolCalls.delete(functionCallId);
                    }
                    // ---

                    const toolResultData: ToolResultData = {
                        toolName: `peer_${responseAgentName}`,
                        functionCallId: functionCallId,
                        resultData: result.status.message,
                        isPeerResponse: true,
                    };

                    visualizerSteps.push({
                        id: `vstep-toolresult-${visualizerSteps.length}-${eventId}`,
                        type: "AGENT_TOOL_EXECUTION_RESULT",
                        timestamp: eventTimestamp,
                        title: `${parentAgentName}: Tool Result - peer_${responseAgentName}`,
                        source: `peer_${responseAgentName}`, // The sub-task agent is the source
                        target: parentAgentName, // The parent agent is the target
                        data: { toolResult: toolResultData },
                        rawEventIds: [eventId],
                        isSubTaskStep: currentEventNestingLevel > 0,
                        nestingLevel: currentEventNestingLevel,
                        owningTaskId: currentEventOwningTaskId,
                        functionCallId: functionCallId,
                    });
                    return;
                }
            }

            // --- Original logic for root task completion or failures ---
            if (["completed", "failed", "canceled"].includes(finalState)) {
                const stepType: VisualizerStepType = finalState === "completed" ? "TASK_COMPLETED" : "TASK_FAILED";
                const title = `${responseAgentName}: Task ${finalState.charAt(0).toUpperCase() + finalState.slice(1)}`;
                let dataPayload: any = {};
                let finalMessageTextFromEvent = "";
                if (result.status.message?.parts) {
                    const textPart = result.status.message.parts.find((p: any) => p.type === "text") as TextPart | undefined;
                    if (textPart?.text) finalMessageTextFromEvent = textPart.text.trim();
                }

                const isRootTaskFinalEvent = currentEventOwningTaskId === parentTaskObject.taskId;
                const includeFinalMessage = finalMessageTextFromEvent && (!isRootTaskFinalEvent || finalMessageTextFromEvent !== lastFlushedAgentResponseText);

                if (stepType === "TASK_COMPLETED") {
                    dataPayload = { finalMessage: includeFinalMessage ? finalMessageTextFromEvent : undefined };
                } else {
                    const errorMessage = includeFinalMessage ? finalMessageTextFromEvent : `Task ${finalState}.`;
                    const errorDetails: { message: string; code?: number | string; details?: any } = { message: errorMessage };
                    const rpcError = payload.error as JSONRPCError | undefined;
                    if (rpcError) {
                        errorDetails.message = rpcError.message || errorDetails.message;
                        errorDetails.code = rpcError.code;
                        if (rpcError.data) errorDetails.details = rpcError.data;
                    }
                    if (result.error) {
                        errorDetails.message = result.error.message || errorDetails.message;
                        errorDetails.code = result.error.code || errorDetails.code;
                        errorDetails.details = result.error.data || errorDetails.details;
                    }
                    dataPayload = { errorDetails };
                }
                visualizerSteps.push({
                    id: `vstep-${finalState}-${visualizerSteps.length}-${eventId}`,
                    type: stepType,
                    timestamp: eventTimestamp,
                    title,
                    source: responseAgentName,
                    target: "User",
                    data: dataPayload,
                    rawEventIds: [eventId],
                    isSubTaskStep: currentEventNestingLevel > 0,
                    nestingLevel: currentEventNestingLevel,
                    owningTaskId: currentEventOwningTaskId,
                    functionCallId: functionCallIdForStep,
                });
                if (isRootTaskFinalEvent) lastFlushedAgentResponseText = null;
                return;
            }
        }

        // Fallback for flushing text if no other condition matched for the current event
        const isStreamingTextEvent = event.direction === "status_update" && payload?.result?.status?.message?.parts?.some((p: any) => p.type === "text");
        let currentEventSourceAgentName = event.source_entity;
        if (payload?.result?.status?.message?.metadata?.forwarded_from_peer) {
            currentEventSourceAgentName = payload.result.status.message.metadata.forwarded_from_peer;
        } else if (payload?.result?.metadata?.agent_name) {
            currentEventSourceAgentName = payload.result.metadata.agent_name;
        } else if (payload?.result?.status?.message?.metadata?.agent_name) {
            currentEventSourceAgentName = payload.result.status.message.metadata.agent_name;
        }

        if (currentAggregatedText.trim() && aggregatedTextSourceAgent) {
            if (!isStreamingTextEvent || (isStreamingTextEvent && currentEventSourceAgentName !== aggregatedTextSourceAgent)) {
                flushAggregatedTextStep(currentEventOwningTaskId);
                if (taskNestingLevels.get(aggregatedRawEventIds[0]?.split("-")[1] || parentTaskObject.taskId) === 0 && !aggregatedTextIsForwardedContext) {
                    lastFlushedAgentResponseText = null;
                }
            }
        }
    });

    // Final flush for any remaining aggregated text
    const lastEventTaskId = sortedEvents.length > 0 ? sortedEvents[sortedEvents.length - 1].task_id || parentTaskObject.taskId : parentTaskObject.taskId;
    flushAggregatedTextStep(lastEventTaskId);

    const startTime = sortedEvents[0] ? getEventTimestamp(sortedEvents[0]) : parentTaskObject.firstSeen.toISOString();
    let endTime: string | undefined = undefined;
    let taskStatus: TaskState = "working";

    const rootTaskSteps = visualizerSteps.filter(step => step.owningTaskId === parentTaskObject.taskId);
    const lastRootTaskStep = rootTaskSteps.length > 0 ? rootTaskSteps[rootTaskSteps.length - 1] : null;

    if (lastRootTaskStep) {
        if (lastRootTaskStep.type === "TASK_COMPLETED") {
            taskStatus = "completed";
            endTime = lastRootTaskStep.timestamp;
        } else if (lastRootTaskStep.type === "TASK_FAILED") {
            taskStatus = "failed";
            endTime = lastRootTaskStep.timestamp;
        }
    }
    if (taskStatus === "working" && sortedEvents.length > 0) {
        const lastOverallEvent = sortedEvents[sortedEvents.length - 1];
        const lastEventTask = allMonitoredTasks[lastOverallEvent.task_id || parentTaskObject.taskId];
        if (lastEventTask) {
            // Future enhancement: check TaskFE status directly
        }
    }

    let totalDurationMs: number | undefined = undefined;
    if (startTime && endTime) {
        totalDurationMs = new Date(endTime).getTime() - new Date(startTime).getTime();
    }

    const visualizedTask: VisualizedTask = {
        taskId: parentTaskObject.taskId,
        initialRequestText: parentTaskObject.initialRequestText,
        status: taskStatus,
        startTime: startTime,
        endTime: endTime,
        durationMs: totalDurationMs,
        steps: visualizerSteps,
    };

    // --- Phase 2: Post-Processing and Final Aggregation ---

    // 1. Calculate aggregated timings for each agent
    Object.values(report.agents).forEach(agentMetrics => {
        // 1a. Calculate total LLM time
        agentMetrics.totalLlmTimeMs = agentMetrics.llmCalls.reduce((sum, call) => sum + call.durationMs, 0);

        // 1b. Calculate total Tool time, handling parallelism
        const sequentialCalls = agentMetrics.toolCalls.filter(call => !call.parallelBlockId);
        const parallelBlocks = new Map<string, ToolCallPerformance[]>();

        agentMetrics.toolCalls.forEach(call => {
            if (call.parallelBlockId) {
                if (!parallelBlocks.has(call.parallelBlockId)) {
                    parallelBlocks.set(call.parallelBlockId, []);
                }
                parallelBlocks.get(call.parallelBlockId)!.push(call);
            }
        });

        const sequentialTime = sequentialCalls.reduce((sum, call) => sum + call.durationMs, 0);

        let parallelTime = 0;
        parallelBlocks.forEach(blockCalls => {
            if (blockCalls.length > 0) {
                const startTime = Math.min(...blockCalls.map(call => new Date(call.timestamp).getTime()));
                const endTime = Math.max(...blockCalls.map(call => new Date(call.timestamp).getTime() + call.durationMs));
                parallelTime += endTime - startTime;
            }
        });

        agentMetrics.totalToolTimeMs = sequentialTime + parallelTime;
    });

    // 2. Assign unique display names for parallel instances
    const agentInstancesByName = new Map<string, AgentPerformanceMetrics[]>();
    Object.values(report.agents).forEach(agentMetrics => {
        if (!agentInstancesByName.has(agentMetrics.agentName)) {
            agentInstancesByName.set(agentMetrics.agentName, []);
        }
        agentInstancesByName.get(agentMetrics.agentName)!.push(agentMetrics);
    });

    agentInstancesByName.forEach(instances => {
        if (instances.length > 1) {
            // Sort instances by their first activity time to ensure consistent naming
            instances.sort((a, b) => {
                const getFirstTimestamp = (metrics: AgentPerformanceMetrics): number => {
                    const allTimestamps = [...metrics.llmCalls.map(c => new Date(c.timestamp).getTime()), ...metrics.toolCalls.map(c => new Date(c.timestamp).getTime())];
                    return allTimestamps.length > 0 ? Math.min(...allTimestamps) : Infinity;
                };
                return getFirstTimestamp(a) - getFirstTimestamp(b);
            });

            // Assign numbered display names
            instances.forEach((instance, index) => {
                instance.displayName = `${instance.agentName} (${index + 1})`;
            });
        }
    });

    // 3. Link peer delegations to unique display names
    const subTaskToDisplayNameMap = new Map<string, string>();
    Object.values(report.agents).forEach(agentMetrics => {
        // The instanceId is "AgentName:owningTaskId"
        const owningTaskId = agentMetrics.instanceId.split(":").slice(1).join(":");
        if (owningTaskId) {
            subTaskToDisplayNameMap.set(owningTaskId, agentMetrics.displayName);
        }
    });

    Object.values(report.agents).forEach(agentMetrics => {
        agentMetrics.toolCalls.forEach(call => {
            if (call.isPeer && call.subTaskId) {
                const peerDisplayName = subTaskToDisplayNameMap.get(call.subTaskId);
                if (peerDisplayName) {
                    call.peerAgentName = peerDisplayName;
                }
            }
        });
    });

    // 4. Calculate overall task duration for the report
    if (totalDurationMs !== undefined) {
        report.overall.totalTaskDurationMs = totalDurationMs;
    }

    // --- End of Phase 2 ---

    visualizedTask.performanceReport = report;

    return visualizedTask;
};
