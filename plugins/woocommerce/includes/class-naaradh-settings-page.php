<?php
/**
 * The WooCommerce settings tab.
 *
 * @package Naaradh
 */

declare( strict_types = 1 );

defined( 'ABSPATH' ) || exit;

/**
 * A WC_Settings_Page so the tab behaves like every other WooCommerce setting: nonces, saving
 * and capability checks are WooCommerce's.
 */
class Naaradh_Settings_Page extends WC_Settings_Page {

	public function __construct() {
		$this->id    = 'naaradh';
		$this->label = __( 'Naaradh', 'naaradh' );
		parent::__construct();
	}

	/**
	 * @return array<int,array<string,mixed>>
	 */
	public function get_settings(): array {
		$diagnostics = $this->diagnostics();

		return array(
			array(
				'title' => __( 'Naaradh — AI calls', 'naaradh' ),
				'type'  => 'title',
				'desc'  => $diagnostics . '<p>' . esc_html__( 'Naaradh places the calls through its own compliance layer: calling windows, consent, do-not-disturb, complaint handling. This plugin reports orders and carts and writes results back as order notes.', 'naaradh' ) . '</p>',
				'id'    => 'naaradh_options',
			),
			array(
				'title'    => __( 'API key', 'naaradh' ),
				'desc_tip' => __( 'A secret key from your Naaradh dashboard (Developers). Needs the scopes: intents:create, orders:write, carts:write.', 'naaradh' ),
				'id'       => Naaradh_Settings::OPT_API_KEY,
				'type'     => 'password',
				'default'  => '',
			),
			array(
				'title'    => __( 'API base URL', 'naaradh' ),
				'desc_tip' => __( 'Leave as is unless Naaradh support tells you otherwise.', 'naaradh' ),
				'id'       => Naaradh_Settings::OPT_API_BASE,
				'type'     => 'text',
				'default'  => 'https://api.naaradh.com',
			),
			array(
				'title'   => __( 'Confirm cash-on-delivery orders', 'naaradh' ),
				'desc'    => __( 'Call the customer within 30 minutes of a COD order to confirm it.', 'naaradh' ),
				'id'      => Naaradh_Settings::OPT_COD_CALLS,
				'type'    => 'checkbox',
				'default' => 'yes',
			),
			array(
				'title'   => __( 'Recover abandoned carts', 'naaradh' ),
				'desc'    => __( 'Report carts so Naaradh can call customers who left one — only those who ticked the consent box below.', 'naaradh' ),
				'id'      => Naaradh_Settings::OPT_CART_CALLS,
				'type'    => 'checkbox',
				'default' => 'no',
			),
			array(
				'title'    => __( 'Consent wording version', 'naaradh' ),
				'desc_tip' => __( 'Copy it from your Naaradh dashboard. A version Naaradh did not publish is not treated as consent, and those customers are never called.', 'naaradh' ),
				'id'       => Naaradh_Settings::OPT_CONSENT_VER,
				'type'     => 'text',
				'default'  => '',
			),
			array(
				'title'    => __( 'Consent checkbox text', 'naaradh' ),
				'desc_tip' => __( 'The exact text Naaradh published for that version, with your store name in it. Do not reword it.', 'naaradh' ),
				'id'       => Naaradh_Settings::OPT_CONSENT_TEXT,
				'type'     => 'textarea',
				'css'      => 'height:80px',
				'default'  => '',
			),
			array(
				'title'    => __( 'Webhook signing secret', 'naaradh' ),
				'desc_tip' => __( 'From the webhook you registered in Naaradh pointing at the URL shown above. Results are written as order notes only when the signature matches.', 'naaradh' ),
				'id'       => Naaradh_Settings::OPT_WEBHOOK_KEY,
				'type'     => 'password',
				'default'  => '',
			),
			array(
				'type' => 'sectionend',
				'id'   => 'naaradh_options',
			),
		);
	}

	/** What is working and what is not — the first thing a merchant should read. */
	private function diagnostics(): string {
		$rows  = array();
		$rows[] = sprintf(
			/* translators: %s: REST URL results are posted to. */
			esc_html__( 'Send call results to this URL: %s', 'naaradh' ),
			'<code>' . esc_url( rest_url( 'naaradh/v1/events' ) ) . '</code>'
		);
		if ( '' === Naaradh_Settings::api_key() ) {
			$rows[] = '<strong>' . esc_html__( 'No API key yet — nothing is being sent to Naaradh.', 'naaradh' ) . '</strong>';
		}
		if ( Naaradh_Settings::cart_calls_enabled() && ! Naaradh_Settings::consent_configured() ) {
			$rows[] = '<strong>' . esc_html__( 'Cart recovery is on but the consent wording is not set, so no cart can be called.', 'naaradh' ) . '</strong>';
		}
		$error = Naaradh_Settings::last_error();
		if ( '' !== $error ) {
			$rows[] = '<strong style="color:#b32d2e">' . esc_html( $error ) . '</strong>';
		}
		if ( ! $this->has_phone_field() ) {
			$rows[] = esc_html__( 'Your checkout does not ask for a phone number. Naaradh can only call customers who gave one (E-127).', 'naaradh' );
		}
		return '<p>' . implode( '<br>', $rows ) . '</p>';
	}

	private function has_phone_field(): bool {
		$required = get_option( 'woocommerce_checkout_phone_field', 'required' );
		return 'hidden' !== $required;
	}
}
