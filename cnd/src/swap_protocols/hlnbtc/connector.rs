use crate::swap_protocols::{
    hlnbtc::{
        Accepted, Cancelled, Opened, Params, Settled, WaitForAccepted, WaitForCancelled,
        WaitForOpened, WaitForSettled,
    },
    rfc003::{Secret, SecretHash},
};
use anyhow::{Context, Error};
use reqwest::{
    header::{HeaderMap, HeaderValue},
    StatusCode, Url,
};
use serde::Deserialize;
use std::{
    convert::{TryFrom, TryInto},
    io::Read,
    path::PathBuf,
    time::Duration,
};

/// Invoice states.  These mirror the invoice states used by lnd.
// ref: https://api.lightning.community/#invoicestate
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, strum_macros::Display)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum InvoiceState {
    Open,
    Settled,
    Cancelled,
    Accepted,
}

/// Payment status.  These mirror the payment status' used by lnd.
// ref: https://api.lightning.community/#paymentstatus
#[derive(Copy, Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum PaymentStatus {
    Unknown,
    InFlight,
    Succeeded,
    Failed,
}

#[derive(Debug, Deserialize)]
struct Invoice {
    pub value: String,
    pub value_msat: String,
    pub amt_paid_sat: String,
    pub amt_paid_msat: String,
    pub expiry: String,
    pub cltv_expiry: String,
    pub state: InvoiceState,
    pub r_preimage: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct PaymentsResponse {
    payments: Option<Vec<Payment>>,
}

#[derive(Clone, Debug, Deserialize)]
struct Payment {
    pub value_msat: Option<String>,
    pub payment_preimage: Option<Secret>,
    pub status: PaymentStatus,
    pub payment_hash: SecretHash,
}

#[derive(Clone, Debug)]
pub struct LndConnectorParams {
    lnd_url: Url,
    retry_interval_ms: u64,
    certificate: Certificate,
    macaroon: Macaroon,
}

impl LndConnectorParams {
    pub fn new(
        lnd_url: Url,
        retry_interval_ms: u64,
        certificate_path: PathBuf,
        macaroon_path: PathBuf,
    ) -> anyhow::Result<LndConnectorParams> {
        let certificate = read_file(certificate_path)?;
        let macaroon = read_file(macaroon_path)?;
        Ok(LndConnectorParams {
            lnd_url,
            retry_interval_ms,
            certificate,
            macaroon,
        })
    }
}

fn read_file<T>(path: PathBuf) -> anyhow::Result<T>
where
    T: TryFrom<Vec<u8>, Error = Error>,
{
    let mut buf = Vec::new();
    std::fs::File::open(path)?.read_to_end(&mut buf)?;
    Ok(buf.try_into()?)
}

#[derive(Clone, Debug)]
struct Certificate(reqwest::Certificate);

impl TryFrom<Vec<u8>> for Certificate {
    type Error = Error;
    fn try_from(buf: Vec<u8>) -> Result<Self, Error> {
        Ok(Certificate(reqwest::Certificate::from_pem(&buf)?))
    }
}

#[derive(Clone, Debug)]
/// The string is hex encoded
struct Macaroon(String);

impl TryFrom<Vec<u8>> for Macaroon {
    type Error = Error;
    fn try_from(buf: Vec<u8>) -> Result<Self, Error> {
        Ok(Macaroon(hex::encode(buf)))
    }
}

/// LND connector for connecting to an LND node when sending a lightning
/// payment.
///
/// When connecting to LND as the sender all state decisions must be made based
/// on the payment status.  This is because only the receiver has the invoice,
/// the sender makes payments using the swap parameters.
#[derive(Clone, Debug)]
pub struct LndConnectorAsSender {
    lnd_url: Url,
    retry_interval_ms: u64,
    certificate: Certificate,
    macaroon: Macaroon,
}

impl From<LndConnectorParams> for LndConnectorAsSender {
    fn from(params: LndConnectorParams) -> Self {
        Self {
            lnd_url: params.lnd_url,
            retry_interval_ms: params.retry_interval_ms,
            certificate: params.certificate,
            macaroon: params.macaroon,
        }
    }
}

impl LndConnectorAsSender {
    fn payment_url(&self) -> Url {
        self.lnd_url
            .join("/v1/payments?include_incomplete=true")
            .expect("append valid string to url")
    }

    async fn find_payment(
        &self,
        secret_hash: SecretHash,
        status: PaymentStatus,
    ) -> Result<Option<Payment>, Error> {
        let response = client(&self.certificate, &self.macaroon)?
            .get(self.payment_url())
            .send()
            .await?
            .json::<PaymentsResponse>()
            .await?;
        let payment = response
            .payments
            .unwrap_or_default()
            .into_iter()
            .find(|payment| payment.payment_hash == secret_hash && payment.status == status);

        Ok(payment)
    }
}

#[async_trait::async_trait]
impl WaitForOpened for LndConnectorAsSender {
    async fn wait_for_opened(&self, _params: Params) -> Result<Opened, Error> {
        // At this stage there is no way for the sender to know when the invoice is
        // added on receiver's side.
        Ok(Opened)
    }
}

#[async_trait::async_trait]
impl WaitForAccepted for LndConnectorAsSender {
    async fn wait_for_accepted(&self, params: Params) -> Result<Accepted, Error> {
        // No validation of the parameters because once the payment has been
        // sent the sender cannot cancel it.
        while self
            .find_payment(params.secret_hash, PaymentStatus::InFlight)
            .await?
            .is_none()
        {
            tokio::time::delay_for(Duration::from_millis(self.retry_interval_ms)).await;
        }

        Ok(Accepted)
    }
}

#[async_trait::async_trait]
impl WaitForSettled for LndConnectorAsSender {
    async fn wait_for_settled(&self, params: Params) -> Result<Settled, Error> {
        let payment = loop {
            match self
                .find_payment(params.secret_hash, PaymentStatus::Succeeded)
                .await?
            {
                Some(payment) => break payment,
                None => {
                    tokio::time::delay_for(Duration::from_millis(self.retry_interval_ms)).await;
                }
            }
        };

        let secret = match payment.payment_preimage {
            Some(secret) => Ok(secret),
            None => Err(anyhow::anyhow!(
                "Pre-image is not present on lnd response for a successful payment: {}",
                params.secret_hash
            )),
        }?;
        Ok(Settled { secret })
    }
}

#[async_trait::async_trait]
impl WaitForCancelled for LndConnectorAsSender {
    async fn wait_for_cancelled(&self, params: Params) -> Result<Cancelled, Error> {
        while self
            .find_payment(params.secret_hash, PaymentStatus::Failed)
            .await?
            .is_none()
        {
            tokio::time::delay_for(Duration::from_millis(self.retry_interval_ms)).await;
        }

        Ok(Cancelled)
    }
}

/// LND connector for connecting to an LND node when receiving a lightning
/// payment.
///
/// When connecting to LND as the receiver all state decisions can be made based
/// on the invoice state.  Since as the receiver, we add the invoice we have
/// access to its state.
#[derive(Clone, Debug)]
pub struct LndConnectorAsReceiver {
    lnd_url: Url,
    retry_interval_ms: u64,
    certificate: Certificate,
    macaroon: Macaroon,
}

impl From<LndConnectorParams> for LndConnectorAsReceiver {
    fn from(params: LndConnectorParams) -> Self {
        Self {
            lnd_url: params.lnd_url,
            retry_interval_ms: params.retry_interval_ms,
            certificate: params.certificate,
            macaroon: params.macaroon,
        }
    }
}

impl LndConnectorAsReceiver {
    fn invoice_url(&self, secret_hash: SecretHash) -> Result<Url, Error> {
        Ok(self
            .lnd_url
            .join("/v1/invoice/")
            .expect("append valid string to url")
            .join(format!("{:x}", secret_hash).as_str())?)
    }

    #[tracing::instrument(level = "debug", skip(self))]
    async fn find_invoice(
        &self,
        secret_hash: SecretHash,
        expected_state: InvoiceState,
    ) -> Result<Option<Invoice>, Error> {
        let response = client(&self.certificate, &self.macaroon)?
            .get(self.invoice_url(secret_hash)?)
            .send()
            .await?;

        if response.status() == StatusCode::NOT_FOUND {
            tracing::debug!("invoice not found");
            return Ok(None);
        }

        // Need to shortcut here until https://github.com/hyperium/hyper/issues/2171 or https://github.com/lightningnetwork/lnd/issues/4135 is resolved
        if response.status() == StatusCode::INTERNAL_SERVER_ERROR {
            return Ok(None);
        }

        if !response.status().is_success() {
            let status_code = response.status();
            let lnd_error = response
                .json::<LndError>()
                .await
                // yes we can fail while we already encoundered an error ...
                .with_context(|| format!("encountered {} while fetching invoice but couldn't deserialize error response 🙄", status_code))?;

            return Err(lnd_error.into());
        }

        let invoice = response
            .json::<Invoice>()
            .await
            .context("failed to deserialize response as invoice")?;

        if invoice.state == expected_state {
            Ok(Some(invoice))
        } else {
            tracing::debug!("invoice exists but is in state {}", invoice.state);
            Ok(None)
        }
    }
}

#[derive(Deserialize, Debug, thiserror::Error)]
#[error("{message}")]
struct LndError {
    error: String,
    message: String,
    code: u32,
}

#[async_trait::async_trait]
impl WaitForOpened for LndConnectorAsReceiver {
    async fn wait_for_opened(&self, params: Params) -> Result<Opened, Error> {
        // Do we want to validate that the user used the correct swap parameters
        // when adding the invoice?
        while self
            .find_invoice(params.secret_hash, InvoiceState::Open)
            .await?
            .is_none()
        {
            tokio::time::delay_for(Duration::from_millis(self.retry_interval_ms)).await;
        }

        Ok(Opened)
    }
}

#[async_trait::async_trait]
impl WaitForAccepted for LndConnectorAsReceiver {
    async fn wait_for_accepted(&self, params: Params) -> Result<Accepted, Error> {
        // Validation that sender payed the correct invoice is provided by LND.
        // Since the sender uses the params to make the payment (as apposed to
        // the invoice) LND guarantees that the params match the invoice when
        // updating the invoice status.
        while self
            .find_invoice(params.secret_hash, InvoiceState::Accepted)
            .await?
            .is_none()
        {
            tokio::time::delay_for(Duration::from_millis(self.retry_interval_ms)).await;
        }
        Ok(Accepted)
    }
}

#[async_trait::async_trait]
impl WaitForSettled for LndConnectorAsReceiver {
    async fn wait_for_settled(&self, params: Params) -> Result<Settled, Error> {
        let invoice = loop {
            match self
                .find_invoice(params.secret_hash, InvoiceState::Settled)
                .await?
            {
                Some(invoice) => break invoice,
                None => tokio::time::delay_for(Duration::from_millis(self.retry_interval_ms)).await,
            }
        };

        let preimage = invoice
            .r_preimage
            .ok_or_else(|| anyhow::anyhow!("settled invoice does not contain preimage?!"))?;

        Ok(Settled {
            secret: Secret::from_vec(base64::decode(preimage.as_bytes())?.as_slice())?,
        })
    }
}

#[async_trait::async_trait]
impl WaitForCancelled for LndConnectorAsReceiver {
    async fn wait_for_cancelled(&self, params: Params) -> Result<Cancelled, Error> {
        while self
            .find_invoice(params.secret_hash, InvoiceState::Cancelled)
            .await?
            .is_none()
        {
            tokio::time::delay_for(Duration::from_millis(self.retry_interval_ms)).await;
        }
        Ok(Cancelled)
    }
}

fn client(certificate: &Certificate, macaroon: &Macaroon) -> Result<reqwest::Client, Error> {
    let cert = certificate.0.clone();
    let mut default_headers = HeaderMap::with_capacity(1);
    default_headers.insert(
        "Grpc-Metadata-macaroon",
        HeaderValue::from_str(&macaroon.0)?,
    );

    // The generated, self-signed lnd certificate is deemed invalid on macOS
    // Catalina because of new certificate requirements in macOS Catalina: https://support.apple.com/en-us/HT210176
    // By using this conditional compilation step for macOS we accept invalid
    // certificates. This is only a minimal security risk because by default the
    // certificate that lnd generates is configured to only allow connections
    // from localhost. Ticket that will resolve that issue: https://github.com/lightningnetwork/lnd/issues/4201
    #[cfg(target_os = "macos")]
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .add_root_certificate(cert)
        .default_headers(default_headers)
        .build()?;

    #[cfg(not(target_os = "macos"))]
    let client = reqwest::Client::builder()
        .add_root_certificate(cert)
        .default_headers(default_headers)
        .build()?;

    Ok(client)
}
