<?php
/**
 * The call-consent checkbox at checkout.
 *
 * @package Naaradh
 */

declare( strict_types = 1 );

defined( 'ABSPATH' ) || exit;

/**
 * One checkbox, never pre-ticked, whose text and VERSION come from Naaradh (E-13, ADR-0010 §2).
 * What is stored on the order is the version, not "yes": a consent is only as good as the words
 * the shopper actually saw, and those words are published and kept for ever by Naaradh.
 *
 * Supports both checkouts: the classic shortcode (`woocommerce_review_order_before_submit`) and
 * the block checkout (an "additional field" registered with WooCommerce).
 */
class Naaradh_Consent {

	public const FIELD    = 'naaradh_call_consent';
	public const META_KEY = '_naaradh_call_consent';

	public static function init(): void {
		// Classic checkout.
		add_action( 'woocommerce_review_order_before_submit', array( __CLASS__, 'render' ), 20 );
		add_action( 'woocommerce_checkout_create_order', array( __CLASS__ , 'save_classic' ), 10, 2 );
		// Block checkout (WooCommerce 8.9+). Registered only when the API exists.
		add_action( 'woocommerce_init', array( __CLASS__, 'register_block_field' ) );
	}

	public static function render(): void {
		if ( ! Naaradh_Settings::consent_configured() ) {
			return;
		}
		woocommerce_form_field(
			self::FIELD,
			array(
				'type'  => 'checkbox',
				'class' => array( 'form-row', 'naaradh-consent' ),
				'label' => Naaradh_Settings::consent_text(),
			),
			// Never pre-ticked: consent is a positive act.
			''
		);
	}

	/**
	 * @param WC_Order             $order Order being created.
	 * @param array<string,mixed>  $data  Posted checkout data.
	 */
	public static function save_classic( $order, $data ): void {
		unset( $data );
		// WooCommerce has already verified the checkout nonce by this point.
		$ticked = isset( $_POST[ self::FIELD ] ) && '' !== (string) wp_unslash( $_POST[ self::FIELD ] ); // phpcs:ignore WordPress.Security.NonceVerification.Missing
		if ( $ticked && Naaradh_Settings::consent_configured() ) {
			$order->update_meta_data( self::META_KEY, Naaradh_Settings::consent_version() );
		}
	}

	public static function register_block_field(): void {
		if ( ! function_exists( 'woocommerce_register_additional_checkout_field' ) || ! Naaradh_Settings::consent_configured() ) {
			return;
		}
		woocommerce_register_additional_checkout_field(
			array(
				'id'       => 'naaradh/call-consent',
				'label'    => Naaradh_Settings::consent_text(),
				'location' => 'order',
				'type'     => 'checkbox',
				'required' => false,
			)
		);
		add_action(
			'woocommerce_set_additional_field_value',
			static function ( string $key, $value, string $group, $wc_object ): void {
				unset( $group );
				if ( 'naaradh/call-consent' !== $key || true !== $value ) {
					return;
				}
				if ( $wc_object instanceof WC_Order && Naaradh_Settings::consent_configured() ) {
					$wc_object->update_meta_data( self::META_KEY, Naaradh_Settings::consent_version() );
				}
			},
			10,
			4
		);
	}

	/** The version stored on an order, or '' when the box was not ticked. */
	public static function version_for_order( WC_Order $order ): string {
		return trim( (string) $order->get_meta( self::META_KEY ) );
	}

	/** The version for the current session's cart, set by the cart block or checkout page. */
	public static function version_for_session(): string {
		if ( ! function_exists( 'WC' ) || null === WC()->session ) {
			return '';
		}
		return trim( (string) WC()->session->get( self::FIELD, '' ) );
	}
}
