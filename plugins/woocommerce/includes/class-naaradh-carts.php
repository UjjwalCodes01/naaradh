<?php
/**
 * Carts → Naaradh (abandoned-cart recovery).
 *
 * @package Naaradh
 */

declare( strict_types = 1 );

defined( 'ABSPATH' ) || exit;

/**
 * A cart is reported only when there is something to call about AND consent to call:
 * a phone number in the session and the consent box ticked (ADR-0011 §1, E-121). Naaradh then
 * decides on its own — 45 idle minutes, under 24 hours, a live consent, one call per number per
 * week. When the order is placed the cart is closed so a queued call stops (E-123).
 *
 * The cart reference is a random token in the session, never a customer id: two visits by one
 * shopper are two carts, and nothing about them identifies a person by itself.
 */
class Naaradh_Carts {

	private const SESSION_REF  = 'naaradh_cart_ref';
	private const SESSION_SENT = 'naaradh_cart_sent_at';
	/** Do not resend the same unchanged cart more often than this (seconds). */
	private const MIN_INTERVAL = 120;

	public static function init(): void {
		add_action( 'woocommerce_checkout_update_order_review', array( __CLASS__, 'on_checkout_review' ), 20, 1 );
		add_action( 'woocommerce_after_calculate_totals', array( __CLASS__, 'maybe_report' ), 20, 0 );
	}

	/**
	 * The classic checkout posts the form as the customer fills it in: that is where a phone
	 * number and the ticked box first exist, before any order.
	 *
	 * @param string $post_data URL-encoded checkout form data.
	 */
	public static function on_checkout_review( $post_data ): void {
		if ( ! is_string( $post_data ) || null === WC()->session ) {
			return;
		}
		$fields = array();
		parse_str( $post_data, $fields );
		$phone = isset( $fields['billing_phone'] ) ? sanitize_text_field( (string) $fields['billing_phone'] ) : '';
		if ( '' !== $phone ) {
			WC()->session->set( 'naaradh_cart_phone', $phone );
		}
		$name = isset( $fields['billing_first_name'] ) ? sanitize_text_field( (string) $fields['billing_first_name'] ) : '';
		if ( '' !== $name ) {
			WC()->session->set( 'naaradh_cart_name', $name );
		}
		// E-105: unticking withdraws consent, so the absence of the field clears it.
		$ticked = isset( $fields[ Naaradh_Consent::FIELD ] ) && '' !== (string) $fields[ Naaradh_Consent::FIELD ];
		WC()->session->set( Naaradh_Consent::FIELD, $ticked ? Naaradh_Settings::consent_version() : '' );
		self::maybe_report();
	}

	public static function maybe_report(): void {
		if ( ! Naaradh_Settings::cart_calls_enabled() || ! Naaradh_Settings::consent_configured() ) {
			return;
		}
		if ( ! function_exists( 'WC' ) || null === WC()->session || null === WC()->cart || WC()->cart->is_empty() ) {
			return;
		}
		$phone = trim( (string) WC()->session->get( 'naaradh_cart_phone', '' ) );
		if ( '' === $phone ) {
			return;
		}
		$consent = Naaradh_Consent::version_for_session();
		if ( '' === $consent ) {
			// No consent, nothing to call about: the cart is not reported at all (E-121).
			return;
		}
		$last = (int) WC()->session->get( self::SESSION_SENT, 0 );
		if ( time() - $last < self::MIN_INTERVAL ) {
			return;
		}

		$items = array();
		$count = 0;
		foreach ( WC()->cart->get_cart() as $line ) {
			$product  = isset( $line['data'] ) && $line['data'] instanceof WC_Product ? $line['data'] : null;
			$quantity = isset( $line['quantity'] ) ? (int) $line['quantity'] : 0;
			$count   += $quantity;
			if ( null !== $product && count( $items ) < 3 ) {
				$items[] = $quantity . ' × ' . $product->get_name();
			}
		}

		$ref    = self::ref();
		$result = Naaradh_Client::request(
			'PUT',
			'/v1/carts/' . rawurlencode( $ref ),
			array(
				'phone'                   => $phone,
				'phone_region'            => self::region(),
				'name'                    => (string) WC()->session->get( 'naaradh_cart_name', '' ),
				'value_minor'             => (int) round( (float) WC()->cart->get_total( 'edit' ) * 100 ),
				'currency'                => get_woocommerce_currency(),
				'item_summary'            => implode( ', ', $items ),
				'item_count'              => $count,
				'consent_wording_version' => $consent,
				'created_at'              => gmdate( 'c', self::started_at() ),
				'updated_at'              => gmdate( 'c' ),
			)
		);
		if ( null !== $result ) {
			WC()->session->set( self::SESSION_SENT, time() );
		}
	}

	/**
	 * The order was placed: close the cart so a queued or ringing recovery call stops.
	 *
	 * @param WC_Order $order Order.
	 */
	public static function complete_for_order( WC_Order $order ): void {
		if ( ! function_exists( 'WC' ) || null === WC()->session ) {
			return;
		}
		$ref = trim( (string) WC()->session->get( self::SESSION_REF, '' ) );
		if ( '' === $ref ) {
			return;
		}
		Naaradh_Client::request(
			'POST',
			'/v1/carts/' . rawurlencode( $ref ) . '/completed',
			array(
				'order_ref'    => (string) $order->get_id(),
				'completed_at' => gmdate( 'c' ),
			),
			'woo-cart-done-' . $ref
		);
		WC()->session->set( self::SESSION_REF, '' );
		WC()->session->set( self::SESSION_SENT, 0 );
	}

	/** A random per-session cart reference — no customer id, no email, nothing guessable. */
	private static function ref(): string {
		$ref = trim( (string) WC()->session->get( self::SESSION_REF, '' ) );
		if ( '' === $ref ) {
			$ref = 'woo-' . bin2hex( random_bytes( 12 ) );
			WC()->session->set( self::SESSION_REF, $ref );
			WC()->session->set( 'naaradh_cart_started', time() );
		}
		return $ref;
	}

	private static function started_at(): int {
		$started = (int) WC()->session->get( 'naaradh_cart_started', 0 );
		return 0 === $started ? time() : $started;
	}

	private static function region(): string {
		$base = wc_get_base_location();
		return isset( $base['country'] ) && is_string( $base['country'] ) && '' !== $base['country']
			? strtoupper( substr( $base['country'], 0, 2 ) )
			: 'IN';
	}
}
