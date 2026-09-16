<?php
/**
 * Orders → Naaradh: the confirmation call and the support-line order cache.
 *
 * @package Naaradh
 */

declare( strict_types = 1 );

defined( 'ABSPATH' ) || exit;

/**
 * Two calls per order, both idempotent on the order id (invariant 10), so a retried hook or a
 * status change cannot produce a second phone call:
 *   PUT  /v1/orders/{id}   — what the support line answers from (every order, COD or not)
 *   POST /v1/intents       — the COD confirmation call (COD orders only, once)
 *
 * Nothing here cancels or edits the order. A cancellation decided on a call arrives as an order
 * note through the webhook route, and a person acts on it (invariant 14).
 */
class Naaradh_Orders {

	private const META_INTENT = '_naaradh_intent_id';

	public static function init(): void {
		add_action( 'woocommerce_checkout_order_created', array( __CLASS__, 'on_created' ), 20, 1 );
		add_action( 'woocommerce_store_api_checkout_order_processed', array( __CLASS__, 'on_created' ), 20, 1 );
		add_action( 'woocommerce_order_status_changed', array( __CLASS__, 'on_status_changed' ), 20, 4 );
	}

	/**
	 * @param WC_Order $order Order.
	 */
	public static function on_created( $order ): void {
		if ( ! $order instanceof WC_Order ) {
			return;
		}
		self::push_order( $order );
		// The cart this order came from must stop being a candidate for a recovery call (E-123).
		Naaradh_Carts::complete_for_order( $order );
		if ( Naaradh_Settings::cod_calls_enabled() && self::is_cod( $order ) ) {
			self::create_intent( $order );
		}
	}

	/**
	 * @param int      $order_id Order id.
	 * @param string   $from     Old status.
	 * @param string   $to       New status.
	 * @param WC_Order $order    Order.
	 */
	public static function on_status_changed( $order_id, $from, $to, $order ): void {
		unset( $order_id, $from, $to );
		if ( $order instanceof WC_Order ) {
			self::push_order( $order );
		}
	}

	private static function is_cod( WC_Order $order ): bool {
		return 'cod' === $order->get_payment_method();
	}

	/** The order cache (ADR-0006): status, payment kind, a short item summary, two hashes. */
	private static function push_order( WC_Order $order ): void {
		$items = array();
		foreach ( $order->get_items() as $item ) {
			$items[] = $item->get_quantity() . ' × ' . $item->get_name();
			if ( count( $items ) >= 3 ) {
				break;
			}
		}
		Naaradh_Client::request(
			'PUT',
			'/v1/orders/' . rawurlencode( (string) $order->get_id() ),
			array(
				'name'               => $order->get_order_number(),
				'phone'              => $order->get_billing_phone(),
				'phone_region'       => self::region( $order ),
				'pincode'            => $order->get_shipping_postcode() ?: $order->get_billing_postcode(),
				'payment'            => self::is_cod( $order ) ? 'cod' : 'prepaid',
				'financial_status'   => $order->is_paid() ? 'paid' : 'pending',
				'fulfillment_status' => $order->get_status(),
				'cancelled_at'       => $order->has_status( array( 'cancelled', 'refunded' ) ) ? self::iso( $order->get_date_modified() ) : null,
				'total_minor'        => (int) round( (float) $order->get_total() * 100 ),
				'currency'           => $order->get_currency(),
				'item_summary'       => implode( ', ', $items ),
				'item_count'         => (int) $order->get_item_count(),
				'placed_at'          => self::iso( $order->get_date_created() ),
				'updated_at'         => self::iso( $order->get_date_modified() ),
			)
		);
	}

	/** One confirmation call per order; the API's idempotency key makes a retry a no-op. */
	private static function create_intent( WC_Order $order ): void {
		if ( '' !== (string) $order->get_meta( self::META_INTENT ) ) {
			return;
		}
		$phone = trim( (string) $order->get_billing_phone() );
		if ( '' === $phone ) {
			return;
		}
		$consent = Naaradh_Consent::version_for_order( $order );
		$body    = array(
			'use_case'     => 'cod_confirm',
			'phone'        => $phone,
			'phone_region' => self::region( $order ),
			'name'         => $order->get_billing_first_name(),
			'external_ref' => (string) $order->get_id(),
			'event_ts'     => self::iso( $order->get_date_created() ),
			'value_minor'  => (int) round( (float) $order->get_total() * 100 ),
			'currency'     => $order->get_currency(),
			'variables'    => array(
				'order_ref' => $order->get_order_number(),
				'amount'    => (string) $order->get_total(),
				'currency'  => $order->get_currency(),
			),
		);
		if ( '' !== $consent ) {
			// The same checkbox also records a promotional consent, for cart and feedback calls.
			$body['consent'] = array(
				'purpose'         => 'promotional',
				'source'          => 'checkout',
				'wording_version' => $consent,
			);
		}
		$result = Naaradh_Client::request( 'POST', '/v1/intents', $body, 'woo-order-' . (string) $order->get_id() );
		if ( null === $result ) {
			return;
		}
		$intent_id = isset( $result['intent_id'] ) && is_string( $result['intent_id'] ) ? $result['intent_id'] : '';
		$status    = isset( $result['status'] ) && is_string( $result['status'] ) ? $result['status'] : 'unknown';
		if ( '' !== $intent_id ) {
			$order->update_meta_data( self::META_INTENT, $intent_id );
		}
		$order->add_order_note(
			'scheduled' === $status
				? __( 'Naaradh: confirmation call queued.', 'naaradh' )
				: sprintf(
					/* translators: 1: status from Naaradh, 2: reason, if any. */
					__( 'Naaradh: no confirmation call (%1$s %2$s).', 'naaradh' ),
					$status,
					isset( $result['reason'] ) && is_string( $result['reason'] ) ? $result['reason'] : ''
				)
		);
		$order->save();
	}

	private static function region( WC_Order $order ): string {
		$country = $order->get_billing_country();
		return '' === $country ? 'IN' : strtoupper( substr( $country, 0, 2 ) );
	}

	/**
	 * @param WC_DateTime|null $date Date.
	 */
	private static function iso( $date ): ?string {
		return null === $date ? null : gmdate( 'c', $date->getTimestamp() );
	}
}
