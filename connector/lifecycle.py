"""Small explicit state machine for a single local flight recorder session."""
from dataclasses import dataclass

from .contracts import Lifecycle

ALLOWED: dict[Lifecycle, set[Lifecycle]] = {
    Lifecycle.DISCONNECTED: {Lifecycle.CONNECTED, Lifecycle.ERROR, Lifecycle.INTERRUPTED},
    Lifecycle.CONNECTED: {Lifecycle.RECORDING, Lifecycle.DISCONNECTED, Lifecycle.ERROR},
    Lifecycle.RECORDING: {Lifecycle.FINALIZING, Lifecycle.ERROR},
    Lifecycle.FINALIZING: {Lifecycle.COMPLETED, Lifecycle.ERROR},
    Lifecycle.COMPLETED: {Lifecycle.CONNECTED, Lifecycle.DISCONNECTED},
    Lifecycle.INTERRUPTED: {Lifecycle.CONNECTED, Lifecycle.DISCONNECTED},
    Lifecycle.ERROR: {Lifecycle.DISCONNECTED, Lifecycle.CONNECTED},
}


@dataclass
class LifecycleMachine:
    state: Lifecycle = Lifecycle.DISCONNECTED

    def __post_init__(self) -> None:
        if not isinstance(self.state, Lifecycle):
            self.state = Lifecycle(self.state)

    def transition(self, next_state: Lifecycle) -> Lifecycle:
        if next_state not in ALLOWED[self.state]:
            raise ValueError(f"Invalid flight lifecycle transition: {self.state} -> {next_state}")
        self.state = next_state
        return self.state
