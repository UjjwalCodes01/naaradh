<?php
/**
 * Settings screen and stored options.
 *
 * @package Naaradh
 */

declare( strict_types = 1 );

defined( 'ABSPATH' ) || exit;

/**
 * WooCommerce → Settings → Naaradh. Everything the merchant can change, plus the diagnostics
 * that answer "why is nothing happening?" without reading a log.
 */
class Naaradh_Settings {

	public const OPT_API_KEY      = 'naaradh_api_key';
	public const OPT_API_BASE     = 'naaradh_api_base';
	public const OPT_COD_CALLS    = 'naaradh_cod_calls';
	public const OPT_CART_CALLS   = 'naaradh_cart_calls';
	public const OPT_CONSENT_TEXT = 'naaradh_consent_text';
	public const OPT_CONSENT_VER  = 'naaradh_consent_version';
	public const OPT_WEBHOOK_KEY  = 'naaradh_webhook_secret';
	public const OPT_LAST_ERROR   = 'naaradh_last_error';

	private const DEFAULT_BASE = 'https://api.naaradh.com';

	public static function init(): void {
		add_filter( 'woocommerce_get_settings_pages', array( __CLASS__, 'register_page' ) );
	}

	/**
	 * @param array<int,mixed> $pages WooCommerce settings pages.
	 * @return array<int,mixed>
	 */
	public static function register_page( array $pages ): array {
		require_once NAARADH_PLUGIN_DIR . 'includes/class-naaradh-settings-page.php';
		$pages[] = new Naaradh_Settings_Page();
		return $pages;
	}

	public static function api_key(): string {
		return trim( (string) get_option( self::OPT_API_KEY, '' ) );
	}

	public static function api_base(): string {
		$base = trim( (string) get_option( self::OPT_API_BASE, self::DEFAULT_BASE ) );
		return '' === $base ? self::DEFAULT_BASE : untrailingslashit( $base );
	}

	public static function cod_calls_enabled(): bool {
		return 'yes' === get_option( self::OPT_COD_CALLS, 'yes' );
	}

	public static function cart_calls_enabled(): bool {
		return 'yes' === get_option( self::OPT_CART_CALLS, 'no' );
	}

	/** The exact text Naaradh published for the version below; shown at checkout. */
	public static function consent_text(): string {
		return trim( (string) get_option( self::OPT_CONSENT_TEXT, '' ) );
	}

	/**
	 * The wording VERSION recorded in Naaradh's consent ledger. A version Naaradh did not
	 * publish is not consent (E-106), so this is copied from the dashboard, never invented.
	 */
	public static function consent_version(): string {
		return trim( (string) get_option( self::OPT_CONSENT_VER, '' ) );
	}

	public static function webhook_secret(): string {
		return trim( (string) get_option( self::OPT_WEBHOOK_KEY, '' ) );
	}

	public static function set_last_error( string $message ): void {
		update_option( self::OPT_LAST_ERROR, $message, false );
	}

	public static function last_error(): string {
		return (string) get_option( self::OPT_LAST_ERROR, '' );
	}

	/** True when carts may be reported: the box has to exist before consent can be given. */
	public static function consent_configured(): bool {
		return '' !== self::consent_version() && '' !== self::consent_text();
	}
}
