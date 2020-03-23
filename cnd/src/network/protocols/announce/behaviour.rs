use crate::{
    network::protocols::announce::{
        handler::{self, Handler, HandlerEvent},
        protocol::{OutboundConfig, ReplySubstream},
        SwapDigest,
    },
    swap_protocols::SwapId,
};
use libp2p::{
    core::{ConnectedPoint, Multiaddr, PeerId},
    swarm::{
        NegotiatedSubstream, NetworkBehaviour, NetworkBehaviourAction,
        NetworkBehaviourEventProcess, PollParameters, ProtocolsHandler,
    },
};
use std::{
    collections::VecDeque,
    task::{Context, Poll},
};

/// Network behaviour that announces a swap to peer by sending a `swap_digest`
/// and receives the `swap_id` back.
#[derive(Debug)]
pub struct Announce {
    /// Pending events to be emitted when polled.
    events: VecDeque<NetworkBehaviourAction<OutboundConfig, BehaviourEvent>>,
}

impl Announce {
    /// This is how data flows into the network behaviour from the application
    /// when acting in the Role of Alice.
    pub fn start_announce_protocol(&mut self, outbound_config: OutboundConfig, peer_id: PeerId) {
        self.events.push_back(NetworkBehaviourAction::SendEvent {
            peer_id,
            event: outbound_config,
        });
    }
}

impl Default for Announce {
    fn default() -> Self {
        Announce {
            events: VecDeque::new(),
        }
    }
}

impl NetworkBehaviour for Announce {
    type ProtocolsHandler = Handler;
    type OutEvent = BehaviourEvent;

    fn new_handler(&mut self) -> Self::ProtocolsHandler {
        Handler::default()
    }

    fn addresses_of_peer(&mut self, _: &PeerId) -> Vec<Multiaddr> {
        Vec::new()
    }

    fn inject_connected(&mut self, _peer_id: PeerId, _endpoint: ConnectedPoint) {
        // No need to do anything, both this node and connected peer now have a
        // handler (as spawned by `new_handler`) running in the background.
    }

    fn inject_disconnected(&mut self, _peer_id: &PeerId, _: ConnectedPoint) {}

    fn inject_node_event(&mut self, peer_id: PeerId, event: HandlerEvent) {
        match event {
            HandlerEvent::ReceivedConfirmation(confirmed) => {
                self.events.push_back(NetworkBehaviourAction::GenerateEvent(
                    BehaviourEvent::ReceivedConfirmation {
                        peer: peer_id,
                        swap_id: confirmed.swap_id,
                        swap_digest: confirmed.swap_digest,
                    },
                ));
            }
            HandlerEvent::AwaitingConfirmation(sender) => {
                self.events.push_back(NetworkBehaviourAction::GenerateEvent(
                    BehaviourEvent::AwaitingConfirmation {
                        peer: peer_id,
                        io: sender,
                    },
                ));
            }
            HandlerEvent::Error(error) => {
                self.events.push_back(NetworkBehaviourAction::GenerateEvent(
                    BehaviourEvent::Error {
                        peer: peer_id,
                        error,
                    },
                ));
            }
        }
    }

    fn poll(
        &mut self,
        _cx: &mut Context<'_>,
        _params: &mut impl PollParameters,
    ) -> Poll<
        NetworkBehaviourAction<
            <Self::ProtocolsHandler as ProtocolsHandler>::InEvent,
            Self::OutEvent,
        >,
    > {
        if let Some(event) = self.events.pop_front() {
            return Poll::Ready(event);
        }

        Poll::Pending
    }
}

/// Event emitted  by the `Announce` behaviour.
#[derive(Debug)]
pub enum BehaviourEvent {
    /// This event created when a confirmation message containing a `swap_id` is
    /// received in response to an announce message containing a
    /// `swap_digest`. The Event contains both the swap id and
    /// the swap digest. The announce message is sent by Alice to Bob.
    ReceivedConfirmation {
        /// The peer (Bob) that the swap has been announced to.
        peer: PeerId,
        /// The swap_id returned by the peer (Bob).
        swap_id: SwapId,
        /// The swap_digest
        swap_digest: SwapDigest,
    },

    /// The event is created when a remote sends a `swap_digest`. The event
    /// contains a reply substream for the receiver to send back the
    /// `swap_id` that corresponds to the swap digest. Bob sends the
    /// confirmations message to Alice using the the reply substream.
    AwaitingConfirmation {
        /// The peer (Alice) that the reply substream is connected to.
        peer: PeerId,
        /// The substream (inc. `swap_digest`) to reply on (i.e., send
        /// `swap_id`).
        io: ReplySubstream<NegotiatedSubstream>,
    },

    /// Error while attempting to announce swap to the remote.
    Error {
        /// The peer with whom the error originated.
        peer: PeerId,
        /// The error that occurred.
        error: handler::Error,
    },
}

impl NetworkBehaviourEventProcess<BehaviourEvent> for Announce {
    // Called when announce behaviour produces an event.
    fn inject_event(&mut self, _: BehaviourEvent) {
        unreachable!("Did you compose Announce behaviour with another behaviour?")
    }
}
