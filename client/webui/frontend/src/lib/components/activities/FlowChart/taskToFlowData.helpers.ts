import type { Node, Edge } from "@xyflow/react";
import type { VisualizerStep } from "@/lib/types";
import { EdgeAnimationService } from "./edgeAnimationService";

export interface NodeUpdateData {
    label?: string;
    status?: string;
    isInitial?: boolean;
    isFinal?: boolean;
    description?: string;
}

export interface LayoutContext {
    currentY: number;
    mainX: number;
    subflowXOffset: number;
    yIncrement: number;
    subflowDepth: number;
    agentYPositions: Map<string, number>; // Store Y position of agent nodes for alignment
    orchestratorCopyCount: number; // For unique IDs of duplicated orchestrator nodes
    userGatewayCopyCount: number; // For unique IDs of duplicated user/gateway nodes
    llmNodeXOffset: number; // Horizontal offset for LLM nodes from their calling agent
    agentHorizontalSpacing: number; // Horizontal spacing between sibling agent nodes
    agentsByLevel: Map<number, string[]>; // Store agents at each Y level for horizontal alignment
}

// Layout Management Interfaces
export interface NodeInstance {
    id: string;
    xPosition?: number;
    yPosition: number;
    height: number;
    width: number;
    functionCallId?: string; // The functionCallId that initiated this node
}

export interface PhaseContext {
    id: string;
    orchestratorAgent: NodeInstance;
    userNodes: NodeInstance[];
    subflows: SubflowContext[];
    // Stores all tool instances for tools called directly by this phase's orchestrator
    toolInstances: NodeInstance[];
    currentToolYOffset: number; // Tracks Y offset for next tool called by orchestrator in this phase
    maxY: number; // Max Y reached by elements directly in this phase (orchestrator, its tools)
}

export interface SubflowContext {
    id: string; // Corresponds to subTaskId
    functionCallId: string; // The functionCallId that initiated this subflow
    isParallel: boolean; // True if this subflow is part of a parallel execution
    peerAgent: NodeInstance; // Stores absolute position of the peer agent
    groupNode: NodeInstance; // Stores absolute position of the group
    // Stores all tool instances for tools called by this subflow's peer agent
    toolInstances: NodeInstance[];
    currentToolYOffset: number; // Tracks Y offset for next tool called by peer agent in this subflow
    maxY: number; // Max Y (absolute) reached by elements within this subflow group
    maxContentXRelative: number; // Max X reached by content relative to group's left edge
    callingPhaseId: string;
}

export interface ParallelFlowContext {
    subflowFunctionCallIds: string[];
    completedSubflows: Set<string>;
    startX: number;
    startY: number;
    currentXOffset: number;
    maxHeight: number;
}

export interface AgentNodeInfo {
    id: string;
    name: string;
    type: "orchestrator" | "peer";
    phaseId?: string;
    subflowId?: string;
    context: "main" | "subflow";
    nodeInstance: NodeInstance;
}

export interface AgentRegistry {
    agents: Map<string, AgentNodeInfo>;
    findAgentByName(name: string): AgentNodeInfo | null;
    findAgentById(id: string): AgentNodeInfo | null;
    registerAgent(info: AgentNodeInfo): void;
}

export interface TimelineLayoutManager {
    phases: PhaseContext[];
    currentPhaseIndex: number;
    currentSubflowIndex: number; // -1 if not in a subflow
    parallelFlows: Map<string, ParallelFlowContext>; // Key: an ID for the parallel block

    nextAvailableGlobalY: number; // Tracks the Y for the next major top-level element

    nodeIdCounter: number; // For generating unique IDs
    allCreatedNodeIds: Set<string>; // For the addNode helper
    nodePositions: Map<string, { x: number; y: number }>; // For quick lookup if needed by createEdge

    // Global UserNode tracking for new logic
    allUserNodes: NodeInstance[]; // Global tracking of all user nodes
    userNodeCounter: number; // For unique user node IDs

    // Agent registry for peer-to-peer delegation
    agentRegistry: AgentRegistry;

    // Indentation tracking for agent delegation visualization
    indentationLevel: number; // Current indentation level
    indentationStep: number; // Pixels to indent per level
}

// Layout Constants
export const LANE_X_POSITIONS = {
    USER: 50,
    MAIN_FLOW: 300, // Orchestrator, PeerAgent
    TOOLS: 600,
};

export const Y_START = 50;
export const NODE_HEIGHT = 50; // Approximate height for calculations
export const NODE_WIDTH = 330; // Approximate width for nodes (increased from 250)
export const VERTICAL_SPACING = 50; // Space between distinct phases or elements
export const GROUP_PADDING_Y = 20; // Vertical padding inside a group box
export const GROUP_PADDING_X = 10; // Horizontal padding inside a group box
export const TOOL_STACKING_OFFSET = NODE_HEIGHT + 20; // Vertical offset for stacked tools under the same agent
export const USER_NODE_Y_OFFSET = 90; // Offset to position UserNode slightly lower

// Helper to add a node and corresponding action
export function addNode(nodes: Node[], createdNodeIds: Set<string>, nodePayload: Node): Node {
    nodes.push(nodePayload);
    createdNodeIds.add(nodePayload.id);
    return nodePayload;
}

// Helper to add an edge and corresponding action
export function addEdgeAction(edges: Edge[], edgePayload: Edge): Edge {
    edges.push(edgePayload);
    return edgePayload;
}

// Utility Functions
export function generateNodeId(context: TimelineLayoutManager, prefix: string): string {
    context.nodeIdCounter++;
    return `${prefix.replace(/[^a-zA-Z0-9_]/g, "_")}_${context.nodeIdCounter}`;
}

export function getCurrentPhase(context: TimelineLayoutManager): PhaseContext | null {
    if (context.currentPhaseIndex === -1 || context.currentPhaseIndex >= context.phases.length) {
        return null;
    }
    return context.phases[context.currentPhaseIndex];
}

export function getCurrentSubflow(context: TimelineLayoutManager): SubflowContext | null {
    const phase = getCurrentPhase(context);
    if (!phase || context.currentSubflowIndex === -1 || context.currentSubflowIndex >= phase.subflows.length) {
        return null;
    }
    return phase.subflows[context.currentSubflowIndex];
}

// Helper function to find tool instance by name in array
export function findToolInstanceByName(toolInstances: NodeInstance[], toolName: string, nodes: Node[]): NodeInstance | null {
    // Find the most recent tool instance with matching name
    for (let i = toolInstances.length - 1; i >= 0; i--) {
        const toolInstance = toolInstances[i];
        const toolNode = nodes.find(n => n.id === toolInstance.id);
        if (toolNode?.data?.toolName === toolName) {
            return toolInstance;
        }
    }
    return null;
}

export function findSubflowByFunctionCallId(context: TimelineLayoutManager, functionCallId: string | undefined): SubflowContext | null {
    if (!functionCallId) return null;
    const phase = getCurrentPhase(context);
    if (!phase) return null;

    // Find ALL matching subflows
    const matchingSubflows = phase.subflows.filter(sf => sf.functionCallId === functionCallId);

    if (matchingSubflows.length === 0) {
        return null;
    }

    // Return the last one in the array, as it's the most recently created instance.
    return matchingSubflows[matchingSubflows.length - 1];
}

export function findSubflowBySubTaskId(context: TimelineLayoutManager, subTaskId: string | undefined): SubflowContext | null {
    if (!subTaskId) return null;
    const phase = getCurrentPhase(context);
    if (!phase) return null;

    return phase.subflows.find(sf => sf.id === subTaskId) || null;
}

// Enhanced context resolution with multiple fallback strategies
export function resolveSubflowContext(manager: TimelineLayoutManager, step: VisualizerStep): SubflowContext | null {
    // Strategy 1: Direct function call ID match (for parallel flows)
    if (step.functionCallId) {
        const directMatch = findSubflowByFunctionCallId(manager, step.functionCallId);
        if (directMatch) {
            return directMatch;
        }
    }

    // Strategy 2: Match by owning task ID (for nested delegations)
    if (step.owningTaskId && step.isSubTaskStep) {
        const taskMatch = findSubflowBySubTaskId(manager, step.owningTaskId);
        if (taskMatch) {
            return taskMatch;
        }
    }

    // Strategy 3: Use current subflow context (for sequential flows)
    const currentSubflow = getCurrentSubflow(manager);
    if (currentSubflow) {
        // Verify this is the right context by checking nesting level
        if (step.nestingLevel > 0 && step.isSubTaskStep) {
            return currentSubflow;
        }
    }

    // Strategy 4: Find by agent name and nesting level
    if (step.source && step.nestingLevel > 0) {
        const agentMatch = findSubflowByAgentAndLevel(manager, step.source, step.nestingLevel);
        if (agentMatch) {
            return agentMatch;
        }
    }
    return null;
}

// Find subflow by agent name and nesting level
export function findSubflowByAgentAndLevel(manager: TimelineLayoutManager, agentName: string, nestingLevel: number): SubflowContext | null {
    const currentPhase = getCurrentPhase(manager);
    if (!currentPhase) return null;

    // Normalize agent name
    const normalizedAgentName = agentName.replace(/[^a-zA-Z0-9_]/g, "_");

    // For nesting level 1, look in current phase subflows
    if (nestingLevel === 1) {
        const subflow = currentPhase.subflows.find(sf => sf.peerAgent.id.includes(normalizedAgentName));
        if (subflow) return subflow;
    }

    // For higher nesting levels, use current subflow as fallback
    return getCurrentSubflow(manager);
}

// Enhanced subflow finder by sub-task ID with better matching
export function findSubflowBySubTaskIdEnhanced(manager: TimelineLayoutManager, subTaskId: string): SubflowContext | null {
    const currentPhase = getCurrentPhase(manager);
    if (!currentPhase) return null;

    // Find all matching subflows, using direct or partial match
    const matchingSubflows = currentPhase.subflows.filter(sf => sf.id === subTaskId || sf.id.includes(subTaskId) || subTaskId.includes(sf.id));

    if (matchingSubflows.length === 0) {
        return null;
    }

    // Return the last one in the array, as it's the most recent instance.
    return matchingSubflows[matchingSubflows.length - 1];
}

// Determine if this is truly a parallel flow
export function isParallelFlow(step: VisualizerStep, manager: TimelineLayoutManager): boolean {
    // Case 1: The decision step itself. This is where a parallel flow is defined.
    if (step.data.toolDecision?.isParallel === true) {
        return true;
    }

    // Case 2: The invocation step. This is where a branch of a parallel flow is executed.
    // We must check the specific functionCallId of the invocation, not the parent task's ID,
    // which is what `step.functionCallId` often contains in nested scenarios.
    const invocationFunctionCallId = step.data?.toolInvocationStart?.functionCallId;

    if (invocationFunctionCallId) {
        // Check if this specific invocation is part of any registered parallel flow.
        return Array.from(manager.parallelFlows.values()).some(p => p.subflowFunctionCallIds.includes(invocationFunctionCallId));
    }

    // If the step is not a parallel decision or a tool invocation with a specific ID,
    // it's not considered part of a parallel flow by this logic.
    return false;
}

export function findToolInstanceByNameEnhanced(toolInstances: NodeInstance[], toolName: string, nodes: Node[], functionCallId?: string): NodeInstance | null {
    // First try to match by function call ID if provided
    if (functionCallId) {
        for (let i = toolInstances.length - 1; i >= 0; i--) {
            const toolInstance = toolInstances[i];
            if (toolInstance.functionCallId === functionCallId) {
                const toolNode = nodes.find(n => n.id === toolInstance.id);
                if (toolNode?.data?.toolName === toolName || toolName === "LLM") {
                    return toolInstance;
                }
            }
        }
    }

    return findToolInstanceByName(toolInstances, toolName, nodes);
}

export function createNewMainPhase(manager: TimelineLayoutManager, orchestratorName: string, step: VisualizerStep, nodes: Node[]): PhaseContext {
    const phaseId = `phase_${manager.phases.length}`;
    const orchestratorNodeId = generateNodeId(manager, `${orchestratorName}_${phaseId}`);
    const yPos = manager.nextAvailableGlobalY;

    const orchestratorNode: Node = {
        id: orchestratorNodeId,
        type: "orchestratorNode",
        position: { x: LANE_X_POSITIONS.MAIN_FLOW, y: yPos },
        data: { label: orchestratorName, visualizerStepId: step.id },
    };
    addNode(nodes, manager.allCreatedNodeIds, orchestratorNode);
    manager.nodePositions.set(orchestratorNodeId, orchestratorNode.position);

    const orchestratorInstance: NodeInstance = { id: orchestratorNodeId, yPosition: yPos, height: NODE_HEIGHT, width: NODE_WIDTH };

    // Register the orchestrator agent in the registry
    const agentInfo: AgentNodeInfo = {
        id: orchestratorNodeId,
        name: orchestratorName,
        type: "orchestrator",
        phaseId: phaseId,
        context: "main",
        nodeInstance: orchestratorInstance,
    };
    manager.agentRegistry.registerAgent(agentInfo);

    const newPhase: PhaseContext = {
        id: phaseId,
        orchestratorAgent: orchestratorInstance,
        userNodes: [],
        subflows: [],
        toolInstances: [],
        currentToolYOffset: 0,
        maxY: yPos + NODE_HEIGHT,
    };
    manager.phases.push(newPhase);
    manager.currentPhaseIndex = manager.phases.length - 1;
    manager.currentSubflowIndex = -1; // Ensure we are not in a subflow context
    manager.nextAvailableGlobalY = newPhase.maxY + VERTICAL_SPACING; // Prepare Y for next element

    return newPhase;
}

export function startNewSubflow(manager: TimelineLayoutManager, peerAgentName: string, step: VisualizerStep, nodes: Node[], isParallel: boolean): SubflowContext | null {
    const currentPhase = getCurrentPhase(manager);
    if (!currentPhase) return null;

    const isPeerReturn = step.type === "AGENT_TOOL_EXECUTION_RESULT" && step.data.toolResult?.isPeerResponse === true;

    const sourceAgentName = step.source || "";
    const isFromOrchestrator = isOrchestratorAgent(sourceAgentName);

    if (!isPeerReturn && !isFromOrchestrator && !isParallel) {
        manager.indentationLevel++;
    }

    const subflowId = step.delegationInfo?.[0]?.subTaskId || `subflow_${currentPhase.subflows.length}`;
    const peerAgentNodeId = generateNodeId(manager, `${peerAgentName}_${subflowId}`);
    const groupNodeId = generateNodeId(manager, `group_${peerAgentName}_${subflowId}`);

    const invocationFunctionCallId = step.data?.toolInvocationStart?.functionCallId || step.functionCallId || "";

    let groupNodeX: number;
    let groupNodeY: number;
    let peerAgentY: number;

    const parallelFlow = Array.from(manager.parallelFlows.values()).find(p => p.subflowFunctionCallIds.includes(invocationFunctionCallId));

    if (isParallel && parallelFlow) {
        groupNodeX = parallelFlow.startX + parallelFlow.currentXOffset;
        groupNodeY = parallelFlow.startY;
        peerAgentY = groupNodeY + GROUP_PADDING_Y;
        parallelFlow.currentXOffset += (NODE_WIDTH + GROUP_PADDING_X) * 2.2;
    } else {
        peerAgentY = manager.nextAvailableGlobalY;
        const baseX = LANE_X_POSITIONS.MAIN_FLOW - 50;
        groupNodeX = baseX + manager.indentationLevel * manager.indentationStep;
        groupNodeY = peerAgentY - GROUP_PADDING_Y;
    }

    const peerAgentNode: Node = {
        id: peerAgentNodeId,
        type: "genericAgentNode",
        position: {
            x: 50,
            y: GROUP_PADDING_Y,
        },
        data: { label: peerAgentName, visualizerStepId: step.id },
        parentId: groupNodeId,
    };

    const groupNode: Node = {
        id: groupNodeId,
        type: "group",
        position: { x: groupNodeX, y: groupNodeY },
        data: { label: `${peerAgentName} Sub-flow` },
        style: {
            backgroundColor: "rgba(220, 220, 255, 0.1)",
            border: "1px solid #aac",
            borderRadius: "8px",
            minHeight: `${NODE_HEIGHT + 2 * GROUP_PADDING_Y}px`,
        },
    };
    addNode(nodes, manager.allCreatedNodeIds, groupNode);
    addNode(nodes, manager.allCreatedNodeIds, peerAgentNode);
    manager.nodePositions.set(peerAgentNodeId, peerAgentNode.position);
    manager.nodePositions.set(groupNodeId, groupNode.position);

    const peerAgentInstance: NodeInstance = { id: peerAgentNodeId, xPosition: LANE_X_POSITIONS.MAIN_FLOW, yPosition: peerAgentY, height: NODE_HEIGHT, width: NODE_WIDTH };

    const agentInfo: AgentNodeInfo = {
        id: peerAgentNodeId,
        name: peerAgentName,
        type: "peer",
        phaseId: currentPhase.id,
        subflowId: subflowId,
        context: "subflow",
        nodeInstance: peerAgentInstance,
    };
    manager.agentRegistry.registerAgent(agentInfo);

    const newSubflow: SubflowContext = {
        id: subflowId,
        functionCallId: invocationFunctionCallId,
        isParallel: isParallel,
        peerAgent: peerAgentInstance,
        groupNode: { id: groupNodeId, xPosition: groupNodeX, yPosition: groupNodeY, height: NODE_HEIGHT + 2 * GROUP_PADDING_Y, width: 0 },
        toolInstances: [],
        currentToolYOffset: 0,
        maxY: peerAgentY + NODE_HEIGHT,
        maxContentXRelative: peerAgentNode.position.x + NODE_WIDTH,
        callingPhaseId: currentPhase.id,
    };
    currentPhase.subflows.push(newSubflow);
    manager.currentSubflowIndex = currentPhase.subflows.length - 1;

    if (isParallel && parallelFlow) {
        parallelFlow.maxHeight = Math.max(parallelFlow.maxHeight, newSubflow.groupNode.height);
        manager.nextAvailableGlobalY = parallelFlow.startY + parallelFlow.maxHeight + VERTICAL_SPACING;
    } else {
        manager.nextAvailableGlobalY = newSubflow.groupNode.yPosition + newSubflow.groupNode.height + VERTICAL_SPACING;
    }

    return newSubflow;
}

export function createNewToolNodeInContext(
    manager: TimelineLayoutManager,
    toolName: string,
    toolType: string, // e.g., 'llmNode', 'genericAgentNode' for tools
    step: VisualizerStep,
    nodes: Node[],
    subflow: SubflowContext | null,
    isLLM: boolean = false
): NodeInstance | null {
    const currentPhase = getCurrentPhase(manager);
    if (!currentPhase) return null;

    const contextToolArray = subflow ? subflow.toolInstances : currentPhase.toolInstances;
    const baseLabel = isLLM ? "LLM" : `Tool: ${toolName}`;
    const baseNodeIdPrefix = isLLM ? "LLM" : toolName;

    // Always create new tool instance instead of reusing
    const parentGroupId = subflow ? subflow.groupNode.id : undefined;

    // Calculate tool's absolute Y position
    let toolY_absolute: number;
    let toolX_absolute: number;

    // Position for the node to be created (can be relative or absolute)
    let nodePositionX: number;
    let nodePositionY: number;

    if (subflow) {
        // Tool's Y is relative to the peer agent's absolute Y, plus current offset within the subflow
        toolY_absolute = subflow.peerAgent.yPosition + subflow.currentToolYOffset;
        subflow.currentToolYOffset += TOOL_STACKING_OFFSET;

        // Position tools with a consistent offset from the peer agent node
        // This ensures tools are properly positioned regardless of group indentation
        const peerAgentRelativeX = 50; // The peer agent's x position relative to group
        const toolOffsetFromPeer = 300; // Desired x-distance from peer agent to tool

        // Position the tool relative to the peer agent
        nodePositionX = peerAgentRelativeX + toolOffsetFromPeer;

        // For nodes inside a group, position must be relative to the group's origin
        // groupNode.xPosition and yPosition are absolute
        if (subflow.groupNode.xPosition === undefined || subflow.groupNode.yPosition === undefined) {
            return null;
        }

        // Set absolute position for tracking
        toolX_absolute = subflow.groupNode.xPosition + nodePositionX;

        // Y position relative to group
        nodePositionY = toolY_absolute - subflow.groupNode.yPosition;
    } else {
        // For tools in the main flow (not in a subflow)
        toolX_absolute = LANE_X_POSITIONS.TOOLS; // Default absolute X for main flow tools

        // Tool's Y is relative to the orchestrator agent's absolute Y, plus current offset
        toolY_absolute = currentPhase.orchestratorAgent.yPosition + currentPhase.currentToolYOffset;
        currentPhase.currentToolYOffset += TOOL_STACKING_OFFSET;
        nodePositionX = toolX_absolute;
        nodePositionY = toolY_absolute;
    }

    // Generate unique ID for each tool call using step ID
    const toolNodeId = generateNodeId(manager, `${baseNodeIdPrefix}_${step.id}`);
    const toolNode: Node = {
        id: toolNodeId,
        type: toolType,
        position: { x: nodePositionX, y: nodePositionY },
        data: {
            label: baseLabel,
            visualizerStepId: step.id,
            toolName: toolName,
        },
        parentId: parentGroupId,
    };
    addNode(nodes, manager.allCreatedNodeIds, toolNode);
    manager.nodePositions.set(toolNodeId, { x: nodePositionX, y: nodePositionY });

    // The toolInstance should store the *absolute* position for logical tracking
    const toolInstance: NodeInstance = {
        id: toolNodeId,
        xPosition: toolX_absolute,
        yPosition: toolY_absolute,
        height: NODE_HEIGHT,
        width: NODE_WIDTH,
        functionCallId: step.functionCallId,
    };

    // Add to array instead of map
    contextToolArray.push(toolInstance);

    // Update maxY for the current context (phase or subflow) using absolute Y
    const newMaxYInContext = toolY_absolute + NODE_HEIGHT; // Use absolute Y for maxY tracking
    if (subflow) {
        subflow.maxY = Math.max(subflow.maxY, newMaxYInContext); // subflow.maxY is absolute

        // Update maxContentXRelative to ensure it accounts for the tool node width
        subflow.maxContentXRelative = Math.max(subflow.maxContentXRelative, nodePositionX + NODE_WIDTH);

        // Update group height and nextAvailableGlobalY
        // groupNode.yPosition is absolute. maxY is absolute.
        const requiredGroupHeight = subflow.maxY - subflow.groupNode.yPosition + GROUP_PADDING_Y;
        subflow.groupNode.height = Math.max(subflow.groupNode.height, requiredGroupHeight);

        // Update group width to accommodate the tool nodes
        const requiredGroupWidth = subflow.maxContentXRelative + GROUP_PADDING_X;
        subflow.groupNode.width = Math.max(subflow.groupNode.width || 0, requiredGroupWidth);

        const groupNodeData = nodes.find(n => n.id === subflow.groupNode.id);
        if (groupNodeData) {
            groupNodeData.style = {
                ...groupNodeData.style,
                height: `${subflow.groupNode.height}px`,
                width: `${subflow.groupNode.width}px`,
            };
        }

        manager.nextAvailableGlobalY = subflow.groupNode.yPosition + subflow.groupNode.height + VERTICAL_SPACING;
    } else {
        currentPhase.maxY = Math.max(currentPhase.maxY, newMaxYInContext);
        manager.nextAvailableGlobalY = currentPhase.maxY + VERTICAL_SPACING;
    }

    return toolInstance;
}

export function createNewUserNodeAtBottom(manager: TimelineLayoutManager, currentPhase: PhaseContext, step: VisualizerStep, nodes: Node[]): NodeInstance {
    manager.userNodeCounter++;
    const userNodeId = generateNodeId(manager, `User_response_${manager.userNodeCounter}`);

    // Position at the bottom of the chart
    const userNodeY = manager.nextAvailableGlobalY + 20;

    const userNode: Node = {
        id: userNodeId,
        type: "userNode",
        position: { x: LANE_X_POSITIONS.USER, y: userNodeY },
        data: { label: "User", visualizerStepId: step.id, isBottomNode: true },
    };

    addNode(nodes, manager.allCreatedNodeIds, userNode);
    manager.nodePositions.set(userNodeId, userNode.position);

    const userNodeInstance: NodeInstance = {
        id: userNodeId,
        yPosition: userNodeY,
        height: NODE_HEIGHT,
        width: NODE_WIDTH,
    };

    // Add to both phase and global tracking
    currentPhase.userNodes.push(userNodeInstance);
    manager.allUserNodes.push(userNodeInstance);

    // Update layout tracking
    const newMaxY = userNodeY + NODE_HEIGHT;
    currentPhase.maxY = Math.max(currentPhase.maxY, newMaxY);
    manager.nextAvailableGlobalY = newMaxY + VERTICAL_SPACING;

    return userNodeInstance;
}

export function createTimelineEdge(
    sourceNodeId: string,
    targetNodeId: string,
    step: VisualizerStep,
    edges: Edge[],
    manager: TimelineLayoutManager,
    edgeAnimationService: EdgeAnimationService,
    _processedSteps: VisualizerStep[],
    sourceHandleId?: string,
    targetHandleId?: string
): void {
    if (!sourceNodeId || !targetNodeId || sourceNodeId === targetNodeId) {
        return;
    }

    // Validate that source and target nodes exist
    const sourceExists = manager.allCreatedNodeIds.has(sourceNodeId);
    const targetExists = manager.allCreatedNodeIds.has(targetNodeId);

    if (!sourceExists) {
        return;
    }

    if (!targetExists) {
        return;
    }

    const edgeId = `edge-${sourceNodeId}${sourceHandleId || ""}-to-${targetNodeId}${targetHandleId || ""}-${step.id}`;

    const edgeExists = edges.some(e => e.id === edgeId);

    if (!edgeExists) {
        const label = step.title && step.title.length > 30 ? step.type.replace(/_/g, " ").toLowerCase() : step.title || "";

        // For initial edge creation, assume all agent-to-tool requests start animated
        // The animation service will determine the actual state during replay
        const isAgentToToolRequest = edgeAnimationService.isRequestStep(step);

        const newEdge: Edge = {
            id: edgeId,
            source: sourceNodeId,
            target: targetNodeId,
            label: label,
            type: "defaultFlowEdge", // Ensure this custom edge type is registered
            data: {
                visualizerStepId: step.id,
                isAnimated: isAgentToToolRequest, // Start animated if it's an agent-to-tool request
                animationType: isAgentToToolRequest ? "request" : "static",
                duration: 1.0,
            } as unknown as Record<string, unknown>,
        };

        // Only add handles if they are provided and valid
        if (sourceHandleId) {
            newEdge.sourceHandle = sourceHandleId;
        }
        if (targetHandleId) {
            newEdge.targetHandle = targetHandleId;
        }

        addEdgeAction(edges, newEdge);
    }
}

// Agent Registry Implementation
export function createAgentRegistry(): AgentRegistry {
    const agents = new Map<string, AgentNodeInfo>();

    return {
        agents,
        findAgentByName(name: string): AgentNodeInfo | null {
            // Normalize the name to handle variations like "peer_hirerarchy2" vs "hirerarchy2"
            const normalizedName = name.startsWith("peer_") ? name.substring(5) : name;

            // Find all agents with matching name and return the most recent one
            const matchingAgents: AgentNodeInfo[] = [];
            for (const [, agentInfo] of agents) {
                if (agentInfo.name === normalizedName || agentInfo.name === name) {
                    matchingAgents.push(agentInfo);
                }
            }

            if (matchingAgents.length === 0) {
                return null;
            }

            // Return the most recently created agent (highest node ID counter)
            // Node IDs are generated with incrementing counter, so higher ID = more recent
            return matchingAgents.reduce((latest, current) => {
                const latestIdNum = parseInt(latest.id.split("_").pop() || "0");
                const currentIdNum = parseInt(current.id.split("_").pop() || "0");
                return currentIdNum > latestIdNum ? current : latest;
            });
        },

        findAgentById(id: string): AgentNodeInfo | null {
            for (const [, agentInfo] of agents) {
                if (agentInfo.id === id) {
                    return agentInfo;
                }
            }
            return null;
        },

        registerAgent(info: AgentNodeInfo): void {
            agents.set(info.id, info);
        },
    };
}

// Helper function to get correct handle IDs based on agent type
export function getAgentHandle(agentType: "orchestrator" | "peer", direction: "input" | "output", position: "top" | "bottom" | "right"): string {
    if (agentType === "orchestrator") {
        if (direction === "output") {
            return position === "bottom" ? "orch-bottom-output" : "orch-right-output-tools";
        } else {
            return position === "top" ? "orch-top-input" : "orch-right-input-tools";
        }
    } else {
        // peer
        if (direction === "output") {
            return position === "bottom" ? "peer-bottom-output" : "peer-right-output-tools";
        } else {
            return position === "top" ? "peer-top-input" : "peer-right-input-tools";
        }
    }
}

// Helper function to determine if an agent name represents an orchestrator
export function isOrchestratorAgent(agentName: string): boolean {
    return agentName === "OrchestratorAgent" || agentName.toLowerCase().includes("orchestrator");
}
