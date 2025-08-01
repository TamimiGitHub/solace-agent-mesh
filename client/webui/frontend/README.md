# Frontend Web UI

Frontend interface for the Solace Agent Mesh (SAM) platform. This React application provides a modern chat interface for interacting with AI agents and visualizing agent communication flows.

## Features

- **Chat Interface**: Real-time messaging with AI agents, artifact preview sidepanel, and real-time agent communication flow visualization
- **Agent Discovery**: Display agent cards discovered from the backend
- **Activities Page** *(Enterprise only)*: View list of all tasks and subtasks with flowchart and message details
- **File Handling**: Upload files as chat context and preview or download agent-generated artifacts
- **Real-time Updates**: Live communication via Server-Sent Events

## Development Setup

### Prerequisites
- Node.js 18+
- npm, yarn, or pnpm

### Installation
```bash
cd client/webui/frontend
npm install
```

### Available Scripts
```bash
# Start development server
npm run dev

# Run linting
npm run lint
```

## Architecture

The frontend is organized into reusable modules under `src/lib/`:

- **`/components`**: React components for chat, UI elements, and page layouts
- **`/hooks`**: Custom hooks for state management and API integration
- **`/types`**: TypeScript interfaces for frontend and backend communication
- **`/contexts`**: React contexts for global state management
- **`/providers`**: Provider components for dependency injection
- **`/utils`**: Utility functions and helpers

## Key Components

### Chat Interface
- `ChatPage`: Main chat interface with resizable panels and artifact preview sidepanel
- `ChatMessageList`: Message container with proper styling
- `ChatInputArea`: Input component for sending messages to agents
- `FlowChartPanel`: Real-time agent communication flow visualization

### Agent Discovery
- Display of agent cards discovered from backend
- Display agent graph with flow chart if configured

### Activities Page *(Enterprise only)*
- View comprehensive list of all tasks and their subtasks
- Interactive flowchart visualization of task relationships
- Detailed message history and communication flows

## Integration

The frontend connects to the backend via:
- **Server-Sent Events (SSE)**: Live event streams from agents
- **REST API**: Standard HTTP requests for configuration and data

## Technology Stack

- **React 19** with TypeScript
- **Vite** for fast development and building
- **Tailwind CSS** for styling
- **shadcn/ui** for accessible component primitives
- **ESLint** for code quality

## Contributing

1. Follow the existing code style and TypeScript conventions
2. Use Tailwind CSS for styling
3. Test components across different screen sizes
4. Run `npm run lint` before submitting changes