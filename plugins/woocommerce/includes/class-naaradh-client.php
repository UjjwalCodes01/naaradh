<?php
/**
 * HTTP client for api.naaradh.com. Server-side only: the secret key never leaves PHP.
 *
 * @package Naaradh
 */

declare( strict_types = 1 );

defined( 'ABSPATH' ) || exit;

/**
 * Thin wrapper over wp_remote_request with the rules the API expects: bearer key, an
 * Idempotency-Key on POSTs, a short timeout, and failures that are logged and never fatal —
 * an order must still be placed when Naaradh is unreachable (E-126).
 */
class Naaradh_Client {

	private const TIMEOUT = 8;

	/**
	 * Sends a request. Returns the decoded body on success, null on any failure.
	 *
	 * @param string              $method HTTP method.
	 * @param string              $path   Path starting with /v1/.
	 * @param array<string,mixed> $body   Request body; empty for GET.
	 * @param string|null         $idempotency_key Stable key for POSTs.
	 * @return array<string,mixed>|null
	 */
	public static function request( string $method, string $path, array $body = array(), ?string $idempotency_key = null ): ?array {
		$key = Naaradh_Settings::api_key();
		if ( '' === $key ) {
			return null;
		}
		$args = array(
			'method'  => $method,
			'timeout' => self::TIMEOUT,
			'headers' => array(
				'Authorization' => 'Bearer ' . $key,
				'Content-Type'  => 'application/json',
				'User-Agent'    => 'Naaradh-WooCommerce/' . NAARADH_VERSION,
			),
		);
		if ( null !== $idempotency_key ) {
			$args['headers']['Idempotency-Key'] = $idempotency_key;
		}
		if ( array() !== $body ) {
			$args['body'] = wp_json_encode( $body );
		}

		$response = wp_remote_request( Naaradh_Settings::api_base() . $path, $args );
		if ( is_wp_error( $response ) ) {
			self::log( $method . ' ' . $path . ' failed: ' . $response->get_error_message() );
			return null;
		}
		$status = (int) wp_remote_retrieve_response_code( $response );
		$raw    = (string) wp_remote_retrieve_body( $response );
		if ( $status >= 400 ) {
			// 401/403 usually means the key was revoked or lacks a scope: say so in wp-admin.
			if ( 401 === $status || 403 === $status ) {
				Naaradh_Settings::set_last_error(
					__( 'Naaradh refused the API key. Check the key and its permissions in your Naaradh dashboard (Developers).', 'naaradh' )
				);
			}
			self::log( $method . ' ' . $path . ' → HTTP ' . (string) $status . ' ' . substr( $raw, 0, 300 ) );
			return null;
		}
		Naaradh_Settings::set_last_error( '' );
		$decoded = json_decode( $raw, true );
		return is_array( $decoded ) ? $decoded : array();
	}

	/**
	 * Writes to WooCommerce's log (WooCommerce → Status → Logs, source `naaradh`).
	 * Never logs a phone number: invariant 8 applies to merchants' servers too.
	 *
	 * @param string $message Message.
	 */
	public static function log( string $message ): void {
		if ( function_exists( 'wc_get_logger' ) ) {
			wc_get_logger()->warning( $message, array( 'source' => 'naaradh' ) );
		}
	}
}
