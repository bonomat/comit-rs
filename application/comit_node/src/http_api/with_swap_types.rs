macro_rules! _match_role {
    ($role:ident, $fn:tt) => {{
        use crate::swap_protocols::rfc003::{alice, bob};
        #[allow(clippy::redundant_closure_call)]
        match $role {
            RoleKind::Alice => {
                #[allow(dead_code)]
                type ROLE = alice::State<AL, BL, AA, BA>;
                $fn()
            }
            RoleKind::Bob => {
                #[allow(dead_code)]
                type ROLE = bob::State<AL, BL, AA, BA>;
                $fn()
            }
        }
    }};
}

#[macro_export]
macro_rules! with_swap_types {
    ($metadata:expr, $fn:tt) => {{
        use crate::swap_protocols::{
            ledger::{Bitcoin, Ethereum},
            RoleKind,
        };
        use bitcoin_support::BitcoinQuantity;
        use ethereum_support::EtherQuantity;
        let metadata = $metadata;

        use crate::swap_protocols::{asset::AssetKind, LedgerKind};

        match metadata {
            Metadata {
                alpha_ledger: LedgerKind::Bitcoin(_),
                beta_ledger: LedgerKind::Ethereum(_),
                alpha_asset: AssetKind::Bitcoin(_),
                beta_asset: AssetKind::Ether(_),
                role,
            } => {
                #[allow(dead_code)]
                type AL = Bitcoin;
                #[allow(dead_code)]
                type BL = Ethereum;
                #[allow(dead_code)]
                type AA = BitcoinQuantity;
                #[allow(dead_code)]
                type BA = EtherQuantity;

                _match_role!(role, $fn)
            }
            Metadata {
                alpha_ledger: LedgerKind::Bitcoin(_),
                beta_ledger: LedgerKind::Ethereum(_),
                alpha_asset: AssetKind::Bitcoin(_),
                beta_asset: AssetKind::Erc20(_),
                role,
            } => {
                #[allow(dead_code)]
                type AL = Bitcoin;
                #[allow(dead_code)]
                type BL = Ethereum;
                #[allow(dead_code)]
                type AA = BitcoinQuantity;
                #[allow(dead_code)]
                type BA = Erc20Token;

                _match_role!(role, $fn)
            }
            Metadata {
                alpha_ledger: LedgerKind::Ethereum(_),
                beta_ledger: LedgerKind::Bitcoin(_),
                alpha_asset: AssetKind::Ether(_),
                beta_asset: AssetKind::Bitcoin(_),
                role,
            } => {
                #[allow(dead_code)]
                type AL = Ethereum;
                #[allow(dead_code)]
                type BL = Bitcoin;
                #[allow(dead_code)]
                type AA = EtherQuantity;
                #[allow(dead_code)]
                type BA = BitcoinQuantity;

                _match_role!(role, $fn)
            }
            Metadata {
                alpha_ledger: LedgerKind::Ethereum(_),
                beta_ledger: LedgerKind::Bitcoin(_),
                alpha_asset: AssetKind::Erc20(_),
                beta_asset: AssetKind::Bitcoin(_),
                role,
            } => {
                #[allow(dead_code)]
                type AL = Ethereum;
                #[allow(dead_code)]
                type BL = Bitcoin;
                #[allow(dead_code)]
                type AA = Erc20Token;
                #[allow(dead_code)]
                type BA = BitcoinQuantity;

                _match_role!(role, $fn)
            }
            _ => unimplemented!(),
        }
    }};
}
