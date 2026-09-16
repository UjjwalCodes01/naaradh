<?php
/**
 * Naaradh → WooCommerce: call results as order notes.
 *
 * @package Naaradh
 */

declare( strict_types = 1 );

defined( 'ABSPATH' ) || exit;

/**
 * `POST /wp-json/naaradh/v1/events`. The signature is verified before the body is parsed
 * (E-125, invariant 9 applied in reverse), replays are ignored, and the result is a plain order
 * note. This route never changes an order's status: a cancellation asked for on a call is a note
 * for a person to act on (invariant 14).
 */
class Naaradh_Webhook {

	/** Same window Naaradh signs with. */
	private const REPLAY_WINDOW = 300;
	private const META_SEEN     = '_naaradh_seen_events';

	public static function init(): void {
		add_action( 'rest_api_init', array( __CLASS__, 'register' ) );
	}

	public static function register(): void {
		register_rest_route(
			'naaradh/v1',
			'/events',
			array(
				'methods'             => 'POST',
				'callback'            => array( __CLASS__, 'handle' ),
				// Authentication is the HMAC signature, checked inside the callback.
				'permission_callback' => '__return_true',
			)
		);
	}

	/**
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response
	 */
	public static function handle( WP_REST_Request $request ): WP_REST_Response {
		$secret = Naaradh_Settings::webhook_secret();
		if ( '' === $secret ) {
			return new WP_REST_Response( array( 'error' => 'not_configured' ), 401 );
		}
		$raw       = $request->get_body();
		$signature = (string) $request->get_header( 'x-naaradh-signature' );
		if ( ! self::verify( $raw, $signature, $secret ) ) {
			Naaradh_Client::log( 'rejected an event with a bad signature' );
			return new WP_REST_Response( array( 'error' => 'bad_signature' ), 401 );
		}

		$event = json_decode( $raw, true );
		if ( ! is_array( $event ) ) {
			return new WP_REST_Response( array( 'error' => 'bad_body' ), 400 );
		}
		$type = isset( $event['type'] ) && is_string( $event['type'] ) ? $event['type'] : '';
		$data = isset( $event['data'] ) && is_array( $event['data'] ) ? $event['data'] : array();
		$id   = isset( $event['id'] ) && is_string( $event['id'] ) ? $event['id'] : '';

		$refs = isset( $data['external_refs'] ) && is_array( $data['external_refs'] ) ? $data['external_refs'] : array();
		$order = null;
		foreach ( $refs as $ref ) {
			$candidate = is_string( $ref ) || is_int( $ref ) ? wc_get_order( (int) $ref ) : false;
			if ( $candidate instanceof WC_Order ) {
				$order = $candidate;
				break;
			}
		}
		if ( ! $order instanceof WC_Order ) {
			// Nothing to attach it to (an inbound call, a cart, an order from before install).
			return new WP_REST_Response( array( 'ok' => true, 'note' => 'no_order' ), 200 );
		}
		// At-least-once delivery: the same event id must not add a second note.
		$seen = (array) $order->get_meta( self::META_SEEN );
		if ( '' !== $id && in_array( $id, $seen, true ) ) {
			return new WP_REST_Response( array( 'ok' => true, 'note' => 'duplicate' ), 200 );
		}

		$note = self::note( $type, $data );
		if ( null !== $note ) {
			$order->add_order_note( $note );
			$seen[] = $id;
			$order->update_meta_data( self::META_SEEN, array_slice( $seen, -20 ) );
			$order->save();
		}
		return new WP_REST_Response( array( 'ok' => true ), 200 );
	}

	/**
	 * `t=<unix>,v1=<hex>` over `t + "." + raw body`, constant-time compared.
	 *
	 * @param string $raw       Raw request body.
	 * @param string $signature Header value.
	 * @param string $secret    Shared secret.
	 */
	private static function verify( string $raw, string $signature, string $secret ): bool {
		if ( ! preg_match( '/^t=(\d+),v1=([0-9a-f]{64})$/', $signature, $m ) ) {
			return false;
		}
		$timestamp = (int) $m[1];
		if ( abs( time() - $timestamp ) > self::REPLAY_WINDOW ) {
			return false;
		}
		$expected = hash_hmac( 'sha256', $m[1] . '.' . $raw, $secret );
		return hash_equals( $expected, $m[2] );
	}

	/**
	 * What a merchant reads on the order. Never a phone number, never a transcript.
	 *
	 * @param string              $type Event type.
	 * @param array<string,mixed> $data Event data.
	 */
	private static function note( string $type, array $data ): ?string {
		$str = static function ( string $key ) use ( $data ): string {
			return isset( $data[ $key ] ) && is_string( $data[ $key ] ) ? $data[ $key ] : '';
		};
		switch ( $type ) {
			case 'outcome.final':
				$outcome = $str( 'outcome' );
				$map     = array(
					'confirmed'                    => __( 'Naaradh call: the customer confirmed the order.', 'naaradh' ),
					'confirmed_with_changes'       => __( 'Naaradh call: confirmed, with a change the customer asked for. See the call in your Naaradh dashboard.', 'naaradh' ),
					'cancelled'                    => __( 'Naaradh call: the customer asked to CANCEL this order. Naaradh does not cancel it for you — check and cancel it here if that is right.', 'naaradh' ),
					'rescheduled'                  => __( 'Naaradh call: the customer asked for a different delivery time.', 'naaradh' ),
					'convert_to_prepaid_requested' => __( 'Naaradh call: the customer would rather pay online.', 'naaradh' ),
					'wrong_number'                 => __( 'Naaradh call: wrong number — the person who answered is not the customer.', 'naaradh' ),
					'opt_out'                      => __( 'Naaradh call: the customer asked not to be called again. Naaradh will not call this number.', 'naaradh' ),
					'no_answer'                    => __( 'Naaradh call: nobody answered.', 'naaradh' ),
					'needs_merchant_action'        => __( 'Naaradh call: the customer needs something only your team can do. See the ticket in your Naaradh dashboard.', 'naaradh' ),
				);
				return $map[ $outcome ] ?? sprintf(
					/* translators: %s: outcome code from Naaradh. */
					__( 'Naaradh call result: %s.', 'naaradh' ),
					$outcome
				);
			case 'intent.gated':
				return sprintf(
					/* translators: 1: reason code, 2: explanation. */
					__( 'Naaradh did not call: %1$s — %2$s', 'naaradh' ),
					$str( 'reason' ),
					$str( 'explanation' )
				);
			case 'ticket.created':
				return __( 'Naaradh raised a ticket for this order. See Tickets in your Naaradh dashboard.', 'naaradh' );
			case 'order.recovered':
				return __( 'Naaradh: this order followed an abandoned-cart call the customer answered.', 'naaradh' );
			case 'checkout.recovery_requested':
				return __( 'Naaradh: the customer asked for their cart link — send it with your own email or WhatsApp.', 'naaradh' );
			default:
				return null;
		}
	}
}
