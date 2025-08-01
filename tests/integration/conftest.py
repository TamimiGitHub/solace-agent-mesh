import pytest
import time


from solace_agent_mesh.agent.sac.app import SamAgentApp
from solace_agent_mesh.agent.sac.component import SamAgentComponent
from solace_agent_mesh.agent.tools.registry import tool_registry
from sam_test_infrastructure.gateway_interface.app import TestGatewayApp
from sam_test_infrastructure.gateway_interface.component import (
    TestGatewayComponent,
)
from sam_test_infrastructure.llm_server.server import TestLLMServer
from sam_test_infrastructure.artifact_service.service import (
    TestInMemoryArtifactService,
)

from sam_test_infrastructure.a2a_validator.validator import A2AMessageValidator
from solace_ai_connector.solace_ai_connector import SolaceAiConnector


@pytest.fixture
def mock_gemini_client(monkeypatch):
    """
    Mocks the google.genai.Client and PIL.Image.open to prevent real API calls
    and allow for deterministic testing.
    """

    class MockPILImage:
        def __init__(self):
            self.size = (1, 1)
            self.mode = "RGB"

        def split(self):
            return []

        def save(self, fp, format=None, quality=None):
            fp.write(b"mock_image_bytes")

    def mock_open(fp):
        return MockPILImage()

    try:
        from PIL import Image

        monkeypatch.setattr(Image, "open", mock_open)
    except ImportError:
        pass

    class MockPart:
        def __init__(self, text=None, inline_data=None):
            self.text = text
            self.inline_data = inline_data

    class MockContent:
        def __init__(self, parts):
            self.parts = parts

    class MockCandidate:
        def __init__(self, content):
            self.content = content

    class MockGenerateContentResponse:
        def __init__(self, candidates):
            self.candidates = candidates

    class MockGeminiClient:
        def __init__(self, api_key=None):
            self._api_key = api_key
            self.models = self

        def generate_content(self, model, contents, config):
            if self._api_key != "fake-gemini-api-key":
                raise Exception(
                    "400 INVALID_ARGUMENT. {'error': {'code': 400, 'message': 'API key not valid. Please pass a valid API key.'}}"
                )

            edited_image_bytes = b"edited_image_bytes"
            mock_response = MockGenerateContentResponse(
                candidates=[
                    MockCandidate(
                        content=MockContent(
                            parts=[
                                MockPart(text="Image edited successfully."),
                                MockPart(
                                    inline_data=type(
                                        "obj", (object,), {"data": edited_image_bytes}
                                    )()
                                ),
                            ]
                        )
                    )
                ]
            )
            return mock_response

    monkeypatch.setattr("google.genai.Client", MockGeminiClient)


@pytest.fixture(scope="session")
def test_llm_server():
    """
    Manages the lifecycle of the TestLLMServer for the test session.
    Yields the TestLLMServer instance.
    """
    server = TestLLMServer(host="127.0.0.1", port=8088)
    server.start()

    max_retries = 20
    retry_delay = 0.25
    ready = False
    for i in range(max_retries):
        time.sleep(retry_delay)
        try:
            if server.started:
                print(f"TestLLMServer confirmed started after {i+1} attempts.")
                ready = True
                break
            print(f"TestLLMServer not ready yet (attempt {i+1}/{max_retries})...")
        except Exception as e:
            print(
                f"TestLLMServer readiness check (attempt {i+1}/{max_retries}) encountered an error: {e}"
            )

    if not ready:
        try:
            server.stop()
        except Exception:
            pass
        pytest.fail("TestLLMServer did not become ready in time.")

    print(f"TestLLMServer fixture: Server ready at {server.url}")
    yield server

    print("TestLLMServer fixture: Stopping server...")
    server.stop()
    print("TestLLMServer fixture: Server stopped.")


@pytest.fixture(autouse=True)
def clear_llm_server_configs(test_llm_server: TestLLMServer):
    """
    Automatically clears any primed responses and captured requests from the
    TestLLMServer before each test that uses it (if session-scoped and reused).
    Also clears the global static response.
    """
    test_llm_server.clear_all_configurations()


@pytest.fixture()
def clear_tool_registry_fixture():
    """
    A pytest fixture that clears the tool_registry singleton.
    This is NOT autouse, and should be explicitly used by tests that need
    a clean registry.
    """
    tool_registry.clear()
    yield
    tool_registry.clear()


@pytest.fixture(scope="session")
def test_artifact_service_instance() -> TestInMemoryArtifactService:
    """
    Provides a single instance of TestInMemoryArtifactService for the test session.
    Its state will be cleared by a separate function-scoped fixture.
    """
    service = TestInMemoryArtifactService()
    print("[SessionFixture] TestInMemoryArtifactService instance created for session.")
    yield service
    print("[SessionFixture] TestInMemoryArtifactService session ended.")


@pytest.fixture(autouse=True, scope="function")
async def clear_test_artifact_service_between_tests(
    test_artifact_service_instance: TestInMemoryArtifactService,
):
    """
    Clears all artifacts from the session-scoped TestInMemoryArtifactService after each test.
    """
    yield
    await test_artifact_service_instance.clear_all_artifacts()


@pytest.fixture(scope="session")
def session_monkeypatch():
    """A session-scoped monkeypatch object."""
    mp = pytest.MonkeyPatch()
    print("[SessionFixture] Session-scoped monkeypatch created.")
    yield mp
    print("[SessionFixture] Session-scoped monkeypatch undoing changes.")
    mp.undo()


@pytest.fixture(scope="session")
def shared_solace_connector(
    test_llm_server: TestLLMServer,
    test_artifact_service_instance: TestInMemoryArtifactService,
    session_monkeypatch,
    request,
) -> SolaceAiConnector:
    """
    Creates and manages a single SolaceAiConnector instance with multiple agents
    for integration testing.
    """

    def create_agent_config(
        agent_name,
        description,
        allow_list,
        tools,
        model_suffix,
        session_behavior="RUN_BASED",
    ):
        return {
            "namespace": "test_namespace",
            "supports_streaming": True,
            "agent_name": agent_name,
            "model": {
                "model": f"openai/test-model-{model_suffix}-{time.time_ns()}",
                "api_base": f"{test_llm_server.url}/v1",
                "api_key": f"fake_test_key_{model_suffix}",
            },
            "session_service": {"type": "memory", "default_behavior": session_behavior},
            "artifact_service": {"type": "test_in_memory"},
            "memory_service": {"type": "memory"},
            "agent_card": {
                "description": description,
                "defaultInputModes": ["text"],
                "defaultOutputModes": ["text"],
                "jsonrpc": "2.0",
                "id": "agent_card_pub",
            },
            "agent_card_publishing": {"interval_seconds": 1},
            "agent_discovery": {"enabled": True},
            "inter_agent_communication": {
                "allow_list": allow_list,
                "request_timeout_seconds": 5,
            },
            "tool_output_save_threshold_bytes": 50,
            "tool_output_llm_return_max_bytes": 200,
            "data_tools_config": {
                "max_result_preview_rows": 5,
                "max_result_preview_bytes": 2048,
            },
            "tools": tools,
        }

    test_agent_tools = [
        {
            "tool_type": "python",
            "component_module": "solace_agent_mesh.agent.tools.test_tools",
            "function_name": "time_delay",
            "component_base_path": ".",
        },
        {
            "tool_type": "python",
            "component_module": "tests.integration.test_support.tools",
            "function_name": "get_weather_tool",
            "component_base_path": ".",
        },
        {"tool_type": "builtin", "tool_name": "convert_file_to_markdown"},
        {"tool_type": "builtin-group", "group_name": "artifact_management"},
        {"tool_type": "builtin-group", "group_name": "data_analysis"},
        {"tool_type": "builtin-group", "group_name": "test"},
        {"tool_type": "builtin", "tool_name": "web_request"},
        {"tool_type": "builtin", "tool_name": "mermaid_diagram_generator"},
        {
            "tool_type": "builtin",
            "tool_name": "create_image_from_description",
            "tool_config": {
                "model": "dall-e-3",
                "api_key": "fake-api-key",
                "api_base": f"{test_llm_server.url}",
            },
        },
        {
            "tool_type": "builtin",
            "tool_name": "describe_image",
            "tool_config": {
                "model": "gpt-4-vision-preview",
                "api_key": "fake-api-key",
                "api_base": f"{test_llm_server.url}",
            },
        },
        {
            "tool_type": "builtin",
            "tool_name": "describe_audio",
            "tool_config": {
                "model": "whisper-1",
                "api_key": "fake-api-key",
                "api_base": f"{test_llm_server.url}",
            },
        },
        {
            "tool_type": "builtin",
            "tool_name": "edit_image_with_gemini",
            "tool_config": {
                "model": "gemini-2.0-flash-preview-image-generation",
                "gemini_api_key": "fake-gemini-api-key",
            },
        },
    ]
    sam_agent_app_config = create_agent_config(
        agent_name="TestAgent",
        description="The main test agent (orchestrator)",
        allow_list=["TestPeerAgentA", "TestPeerAgentB"],
        tools=test_agent_tools,
        model_suffix="sam",
    )

    peer_agent_tools = [
        {"tool_type": "builtin-group", "group_name": "artifact_management"},
        {"tool_type": "builtin-group", "group_name": "data_analysis"},
    ]
    peer_a_config = create_agent_config(
        agent_name="TestPeerAgentA",
        description="Peer Agent A, accessible by TestAgent, can access D",
        allow_list=["TestPeerAgentD"],
        tools=peer_agent_tools,
        model_suffix="peerA",
    )
    peer_b_config = create_agent_config(
        agent_name="TestPeerAgentB",
        description="Peer Agent B, accessible by TestAgent, cannot delegate",
        allow_list=[],
        tools=peer_agent_tools,
        model_suffix="peerB",
    )
    peer_c_config = create_agent_config(
        agent_name="TestPeerAgentC",
        description="Peer Agent C, not accessible by TestAgent",
        allow_list=[],
        tools=peer_agent_tools,
        model_suffix="peerC",
        session_behavior="PERSISTENT",
    )
    peer_d_config = create_agent_config(
        agent_name="TestPeerAgentD",
        description="Peer Agent D, accessible by Peer A",
        allow_list=[],
        tools=peer_agent_tools,
        model_suffix="peerD",
    )

    app_infos = [
        {
            "name": "TestSamAgentApp",
            "app_config": sam_agent_app_config,
            "broker": {"dev_mode": True},
            "app_module": "solace_agent_mesh.agent.sac.app",
        },
        {
            "name": "TestPeerAgentA_App",
            "app_config": peer_a_config,
            "broker": {"dev_mode": True},
            "app_module": "solace_agent_mesh.agent.sac.app",
        },
        {
            "name": "TestPeerAgentB_App",
            "app_config": peer_b_config,
            "broker": {"dev_mode": True},
            "app_module": "solace_agent_mesh.agent.sac.app",
        },
        {
            "name": "TestPeerAgentC_App",
            "app_config": peer_c_config,
            "broker": {"dev_mode": True},
            "app_module": "solace_agent_mesh.agent.sac.app",
        },
        {
            "name": "TestPeerAgentD_App",
            "app_config": peer_d_config,
            "broker": {"dev_mode": True},
            "app_module": "solace_agent_mesh.agent.sac.app",
        },
        {
            "name": "TestHarnessGatewayApp",
            "app_config": {
                "namespace": "test_namespace",
                "gateway_id": "TestHarnessGateway_01",
                "artifact_service": {"type": "test_in_memory"},
            },
            "broker": {"dev_mode": True},
            "app_module": "sam_test_infrastructure.gateway_interface.app",
        },
    ]

    session_monkeypatch.setattr(
        "solace_agent_mesh.agent.adk.services.TestInMemoryArtifactService",
        lambda: test_artifact_service_instance,
    )

    log_level_str = request.config.getoption("--log-cli-level") or "INFO"

    connector_config = {
        "apps": app_infos,
        "log": {
            "stdout_log_level": log_level_str.upper(),
            "log_file_level": "INFO",
            "enable_trace": False,
        },
    }
    print(
        f"\n[Conftest] Configuring SolaceAiConnector with stdout log level: {log_level_str.upper()}"
    )
    connector = SolaceAiConnector(config=connector_config)
    connector.run()
    print(
        f"shared_solace_connector fixture: Started SolaceAiConnector with apps: {[app['name'] for app in connector_config['apps']]}"
    )

    # Allow time for agent card discovery messages to be exchanged before any test runs
    print("shared_solace_connector fixture: Waiting for agent discovery...")
    time.sleep(2)
    print("shared_solace_connector fixture: Agent discovery wait complete.")

    yield connector

    print(f"shared_solace_connector fixture: Cleaning up SolaceAiConnector...")
    connector.stop()
    connector.cleanup()
    print(f"shared_solace_connector fixture: SolaceAiConnector cleaned up.")


@pytest.fixture(scope="session")
def sam_app_under_test(shared_solace_connector: SolaceAiConnector) -> SamAgentApp:
    """
    Retrieves the main SamAgentApp instance from the session-scoped SolaceAiConnector.
    """
    app_instance = shared_solace_connector.get_app("TestSamAgentApp")
    assert isinstance(
        app_instance, SamAgentApp
    ), "Failed to retrieve SamAgentApp from shared connector."
    print(
        f"sam_app_under_test fixture: Retrieved app {app_instance.name} from shared SolaceAiConnector."
    )
    yield app_instance


@pytest.fixture(scope="session")
def peer_agent_a_app_under_test(
    shared_solace_connector: SolaceAiConnector,
) -> SamAgentApp:
    """Retrieves the TestPeerAgentA_App instance."""
    app_instance = shared_solace_connector.get_app("TestPeerAgentA_App")
    assert isinstance(
        app_instance, SamAgentApp
    ), "Failed to retrieve TestPeerAgentA_App."
    yield app_instance


@pytest.fixture(scope="session")
def peer_agent_b_app_under_test(
    shared_solace_connector: SolaceAiConnector,
) -> SamAgentApp:
    """Retrieves the TestPeerAgentB_App instance."""
    app_instance = shared_solace_connector.get_app("TestPeerAgentB_App")
    assert isinstance(
        app_instance, SamAgentApp
    ), "Failed to retrieve TestPeerAgentB_App."
    yield app_instance


@pytest.fixture(scope="session")
def peer_agent_c_app_under_test(
    shared_solace_connector: SolaceAiConnector,
) -> SamAgentApp:
    """Retrieves the TestPeerAgentC_App instance."""
    app_instance = shared_solace_connector.get_app("TestPeerAgentC_App")
    assert isinstance(
        app_instance, SamAgentApp
    ), "Failed to retrieve TestPeerAgentC_App."
    yield app_instance


@pytest.fixture(scope="session")
def peer_agent_d_app_under_test(
    shared_solace_connector: SolaceAiConnector,
) -> SamAgentApp:
    """Retrieves the TestPeerAgentD_App instance."""
    app_instance = shared_solace_connector.get_app("TestPeerAgentD_App")
    assert isinstance(
        app_instance, SamAgentApp
    ), "Failed to retrieve TestPeerAgentD_App."
    yield app_instance


def get_component_from_app(app: SamAgentApp) -> SamAgentComponent:
    """Helper to get the component from an app."""
    if app.flows and app.flows[0].component_groups:
        for group in app.flows[0].component_groups:
            for component_wrapper in group:
                component = (
                    component_wrapper.component
                    if hasattr(component_wrapper, "component")
                    else component_wrapper
                )
                if isinstance(component, SamAgentComponent):
                    return component
    raise RuntimeError("SamAgentComponent not found in the application flow.")


@pytest.fixture(scope="session")
def main_agent_component(sam_app_under_test: SamAgentApp) -> SamAgentComponent:
    """Retrieves the main SamAgentComponent instance."""
    return get_component_from_app(sam_app_under_test)


@pytest.fixture(scope="session")
def peer_a_component(peer_agent_a_app_under_test: SamAgentApp) -> SamAgentComponent:
    """Retrieves the TestPeerAgentA component instance."""
    return get_component_from_app(peer_agent_a_app_under_test)


@pytest.fixture(scope="session")
def peer_b_component(peer_agent_b_app_under_test: SamAgentApp) -> SamAgentComponent:
    """Retrieves the TestPeerAgentB component instance."""
    return get_component_from_app(peer_agent_b_app_under_test)


@pytest.fixture(scope="session")
def peer_c_component(peer_agent_c_app_under_test: SamAgentApp) -> SamAgentComponent:
    """Retrieves the TestPeerAgentC component instance."""
    return get_component_from_app(peer_agent_c_app_under_test)


@pytest.fixture(scope="session")
def peer_d_component(peer_agent_d_app_under_test: SamAgentApp) -> SamAgentComponent:
    """Retrieves the TestPeerAgentD component instance."""
    return get_component_from_app(peer_agent_d_app_under_test)


@pytest.fixture(scope="session")
def test_gateway_app_instance(
    shared_solace_connector: SolaceAiConnector,
) -> TestGatewayComponent:
    """
    Retrieves the TestGatewayApp instance from the session-scoped SolaceAiConnector
    and yields its TestGatewayComponent.
    """
    app_instance = shared_solace_connector.get_app("TestHarnessGatewayApp")
    assert isinstance(
        app_instance, TestGatewayApp
    ), "Failed to retrieve TestGatewayApp from shared connector."
    print(
        f"test_gateway_app_instance fixture: Retrieved app {app_instance.name} from shared SolaceAiConnector."
    )

    component_instance = None
    if app_instance.flows and app_instance.flows[0].component_groups:
        for group in app_instance.flows[0].component_groups:
            for comp_wrapper in group:
                actual_comp = (
                    comp_wrapper.component
                    if hasattr(comp_wrapper, "component")
                    else comp_wrapper
                )
                if isinstance(actual_comp, TestGatewayComponent):
                    component_instance = actual_comp
                    break
            if component_instance:
                break

    if not component_instance:
        if hasattr(app_instance, "get_component"):
            comp_from_method = app_instance.get_component()
            if isinstance(comp_from_method, TestGatewayComponent):
                component_instance = comp_from_method
            elif hasattr(comp_from_method, "component") and isinstance(
                comp_from_method.component, TestGatewayComponent
            ):
                component_instance = comp_from_method.component

    if not component_instance:
        pytest.fail(
            "TestGatewayApp did not initialize or TestGatewayComponent instance could not be retrieved via shared SolaceAiConnector."
        )

    print(
        f"[SessionFixture] TestGatewayComponent instance ({component_instance.name}) retrieved for session."
    )
    yield component_instance


@pytest.fixture(autouse=True, scope="function")
def clear_test_gateway_state_between_tests(
    test_gateway_app_instance: TestGatewayComponent,
):
    """
    Clears state from the session-scoped TestGatewayComponent after each test.
    """
    yield
    test_gateway_app_instance.clear_captured_outputs()
    if test_gateway_app_instance.task_context_manager:
        test_gateway_app_instance.task_context_manager.clear_all_contexts_for_testing()


def _clear_agent_component_state(agent_app: SamAgentApp):
    """Helper function to clear state from a SamAgentComponent."""
    component = get_component_from_app(agent_app)

    if component:
        # Clear the central task state dictionary, which now encapsulates all
        # in-flight task information (cancellation, buffers, etc.).
        with component.active_tasks_lock:
            component.active_tasks.clear()

        # The following state is still managed at the component level and needs
        # to be cleared for test isolation.
        if hasattr(component, "_agent_registry") and component._agent_registry:
            component._agent_registry.clear()
        if hasattr(component, "peer_agents") and component.peer_agents:
            component.peer_agents.clear()
        if (
            hasattr(component, "invocation_monitor")
            and component.invocation_monitor
            and hasattr(component.invocation_monitor, "_reset_session")
        ):
            component.invocation_monitor._reset_session()


@pytest.fixture(autouse=True, scope="function")
def clear_all_agent_states_between_tests(
    sam_app_under_test: SamAgentApp,
    peer_agent_a_app_under_test: SamAgentApp,
    peer_agent_b_app_under_test: SamAgentApp,
    peer_agent_c_app_under_test: SamAgentApp,
    peer_agent_d_app_under_test: SamAgentApp,
):
    """Clears state from all agent components after each test."""
    yield
    _clear_agent_component_state(sam_app_under_test)
    _clear_agent_component_state(peer_agent_a_app_under_test)
    _clear_agent_component_state(peer_agent_b_app_under_test)
    _clear_agent_component_state(peer_agent_c_app_under_test)
    _clear_agent_component_state(peer_agent_d_app_under_test)


@pytest.fixture(scope="function")
def a2a_message_validator(
    sam_app_under_test: SamAgentApp,
    peer_agent_a_app_under_test: SamAgentApp,
    peer_agent_b_app_under_test: SamAgentApp,
    peer_agent_c_app_under_test: SamAgentApp,
    peer_agent_d_app_under_test: SamAgentApp,
    test_gateway_app_instance: TestGatewayComponent,
) -> A2AMessageValidator:
    """
    Provides an instance of A2AMessageValidator, activated to monitor all
    agent components and the test gateway.
    """
    validator = A2AMessageValidator()

    # Correctly get SamAgentComponent from sam_app_under_test
    sam_agent_component_instance = None
    if sam_app_under_test.flows and sam_app_under_test.flows[0].component_groups:
        for group in sam_app_under_test.flows[0].component_groups:
            for comp_wrapper in group:
                actual_comp = getattr(comp_wrapper, "component", comp_wrapper)
                if isinstance(actual_comp, SamAgentComponent):
                    sam_agent_component_instance = actual_comp
                    break
            if sam_agent_component_instance:
                break

    def get_component_from_app(app: SamAgentApp):
        if app.flows and app.flows[0].component_groups:
            for group in app.flows[0].component_groups:
                for comp_wrapper in group:
                    actual_comp = (
                        comp_wrapper.component
                        if hasattr(comp_wrapper, "component")
                        else comp_wrapper
                    )
                    if isinstance(actual_comp, SamAgentComponent):
                        return actual_comp
        return None

    all_apps = [
        sam_app_under_test,
        peer_agent_a_app_under_test,
        peer_agent_b_app_under_test,
        peer_agent_c_app_under_test,
        peer_agent_d_app_under_test,
    ]

    components_to_patch = [get_component_from_app(app) for app in all_apps]
    components_to_patch.append(test_gateway_app_instance)

    final_components_to_patch = [c for c in components_to_patch if c is not None]

    if not final_components_to_patch:
        pytest.skip("No suitable components found to patch for A2A validation.")

    print(
        f"A2A Validator activating on components: {[c.name for c in final_components_to_patch]}"
    )
    validator.activate(final_components_to_patch)
    yield validator
    validator.deactivate()
