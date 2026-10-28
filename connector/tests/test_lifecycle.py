import pytest

from connector.contracts import Lifecycle
from connector.lifecycle import LifecycleMachine


def test_full_demo_lifecycle():
    machine = LifecycleMachine()
    for state in (Lifecycle.CONNECTED, Lifecycle.RECORDING, Lifecycle.FINALIZING, Lifecycle.COMPLETED):
        assert machine.transition(state) == state


def test_interrupted_session_can_start_a_new_session_without_becoming_completed():
    machine = LifecycleMachine(Lifecycle.INTERRUPTED)
    assert machine.transition(Lifecycle.CONNECTED) == Lifecycle.CONNECTED
    assert machine.transition(Lifecycle.RECORDING) == Lifecycle.RECORDING


@pytest.mark.parametrize("state", [Lifecycle.RECORDING, Lifecycle.FINALIZING, Lifecycle.COMPLETED])
def test_cannot_skip_connection(state):
    with pytest.raises(ValueError, match="Invalid flight lifecycle"):
        LifecycleMachine().transition(state)
