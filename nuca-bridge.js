/**
 * nuca-bridge.js
 * Liga o painel de admin (Supabase) à loja (index.html).
 * Aplica: modo manutenção, envio, IVA, moeda, envio grátis.
 */

(function () {
    'use strict';

    const SUPABASE_URL = 'https://zrzlyrobfzlcxcbokgnl.supabase.co';
    const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inpyemx5cm9iZnpsY3hjYm9rZ25sIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxNTg3NDcsImV4cCI6MjA4ODczNDc0N30.LlCGKSu1O4oYlqEs1U04xpFfT5xH2qJVc6wGwFdtRsY';

    /* ── Estado interno ── */
    let _settings = {
        freeShippingEnabled: false,
        freeShippingThreshold: 50,
        defaultShippingPrice: 3.99,
        pricesIncludeVat: true,
        currency: 'EUR',
        maintenanceMode: false,
        maintenanceMessage: 'A loja está temporariamente em manutenção. Volte em breve!',
    };

    /* ── Helpers ── */
    function fmt(amount) {
        const symbol = _settings.currency === 'USD' ? '$' : _settings.currency === 'GBP' ? '£' : '€';
        return symbol + parseFloat(amount).toFixed(2);
    }

    function getCartNet() {
        /* cart é a variável global do index.html */
        if (typeof cart === 'undefined' || !Array.isArray(cart)) return 0;
        return cart.reduce((s, item) => s + (parseFloat(item.price) || 0), 0);
    }

    function getShippingCost(netTotal) {
        if (_settings.freeShippingEnabled && netTotal >= _settings.freeShippingThreshold) return 0;
        return _settings.defaultShippingPrice;
    }

    /* ── Actualizar UI do carrinho ── */
    function updateShippingUI() {
        const net = getCartNet();
        const shipping = getShippingCost(net);
        const total = net + shipping;

        /* valor de envio */
        const shippingEl = document.getElementById('cart-shipping-value');
        if (shippingEl) {
            if (shipping === 0) {
                shippingEl.textContent = 'Grátis';
                shippingEl.style.color = '#10B981';
            } else {
                shippingEl.textContent = fmt(shipping);
                shippingEl.style.color = '';
            }
        }

        /* linha de progresso para envio grátis */
        const threshEl = document.getElementById('cart-shipping-threshold');
        if (threshEl && _settings.freeShippingEnabled) {
            if (shipping > 0) {
                const remaining = _settings.freeShippingThreshold - net;
                threshEl.style.display = 'block';
                threshEl.textContent = `Faltam ${fmt(Math.max(0, remaining))} para envio grátis`;
            } else {
                threshEl.style.display = 'none';
            }
        } else if (threshEl) {
            threshEl.style.display = 'none';
        }

        /* total final */
        const totalEl = document.getElementById('cart-total');
        if (totalEl) totalEl.textContent = fmt(total);

        /* linha de IVA */
        const vatRow = document.getElementById('cart-vat-row');
        const vatLabel = document.getElementById('cart-vat-label');
        if (vatRow && vatLabel) {
            if (_settings.pricesIncludeVat) {
                vatRow.style.display = 'flex';
                vatLabel.textContent = 'IVA incluído nos preços';
            } else {
                vatRow.style.display = 'none';
            }
        }

        /* marquee – actualizar texto de envio grátis */
        _updateMarquee();
    }

    function _updateMarquee() {
        if (!_settings.freeShippingEnabled) return;
        const threshold = _settings.freeShippingThreshold;
        document.querySelectorAll('.marquee-content').forEach(el => {
            el.innerHTML = el.innerHTML.replace(
                /ENVIO GRÁTIS EM COMPRAS ACIMA DE [^•]+/g,
                `ENVIO GRÁTIS EM COMPRAS ACIMA DE ${fmt(threshold)} `
            );
        });
    }

    /* ── Modo manutenção ── */
    function applyMaintenanceMode() {
        const overlay = document.getElementById('nuca-maintenance-overlay');
        if (!overlay) return;
        if (_settings.maintenanceMode) {
            const msgEl = document.getElementById('nuca-maintenance-msg');
            if (msgEl && _settings.maintenanceMessage) {
                msgEl.textContent = _settings.maintenanceMessage;
            }
            overlay.style.display = 'flex';
            document.body.style.overflow = 'hidden';
        } else {
            overlay.style.display = 'none';
            document.body.style.overflow = '';
        }
    }

    /* ── Carregar configurações do Supabase ── */
    async function loadSettings() {
        try {
            const sb = window.supabase
                ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY)
                : null;

            if (!sb) {
                console.warn('[nuca-bridge] Supabase não disponível.');
                setDefaultShippingUI();
                return;
            }

            /* Configurações da loja */
            const { data: shop } = await sb
                .from('shop_settings')
                .select('maintenance_mode,maintenance_message,currency,prices_include_vat')
                .eq('id', 1)
                .single();

            if (shop) {
                _settings.maintenanceMode = shop.maintenance_mode || false;
                _settings.maintenanceMessage = shop.maintenance_message || _settings.maintenanceMessage;
                _settings.currency = shop.currency || 'EUR';
                _settings.pricesIncludeVat = shop.prices_include_vat !== false;
            }

            /* Configurações de envio */
            const { data: shipSettings } = await sb
                .from('shipping_settings')
                .select('free_shipping_enabled,free_shipping_threshold')
                .eq('id', 1)
                .single();

            if (shipSettings) {
                _settings.freeShippingEnabled = shipSettings.free_shipping_enabled || false;
                _settings.freeShippingThreshold = parseFloat(shipSettings.free_shipping_threshold) || 50;
            }

            /* Preço de envio padrão — zona Portugal continental */
            const { data: zones } = await sb
                .from('shipping_zones')
                .select('price,name')
                .order('sort_order', { ascending: true })
                .limit(5);

            if (zones && zones.length > 0) {
                /* Procura zona Portugal ou usa a primeira */
                const pt = zones.find(z =>
                    z.name.toLowerCase().includes('portugal') ||
                    z.name.toLowerCase().includes('continental') ||
                    z.name.toLowerCase().includes('nacional')
                ) || zones[0];
                _settings.defaultShippingPrice = parseFloat(pt.price) || 3.99;
            }

        } catch (err) {
            console.warn('[nuca-bridge] Erro ao carregar configurações:', err.message);
        } finally {
            /* Aplicar sempre, mesmo em erro */
            applyMaintenanceMode();
            updateShippingUI();
            patchUpdateCartUI();
        }
    }

    /* ── Fallback se Supabase falhar ── */
    function setDefaultShippingUI() {
        const shippingEl = document.getElementById('cart-shipping-value');
        if (shippingEl) {
            shippingEl.textContent = fmt(_settings.defaultShippingPrice);
        }
        updateShippingUI();
        patchUpdateCartUI();
    }

    /* ── Patch updateCartUI do index.html ── */
    /* Intercepta a função global para que sempre que o carrinho mude
       o envio também seja recalculado. */
    function patchUpdateCartUI() {
        if (typeof window.updateCartUI !== 'function') return;
        if (window.__nucaBridgePatched) return;
        window.__nucaBridgePatched = true;

        const _original = window.updateCartUI.bind(window);
        window.updateCartUI = function () {
            _original();
            /* Pequeno atraso para garantir que o DOM do original já actualizou */
            setTimeout(updateShippingUI, 0);
        };

        /* Correr imediatamente para o estado actual */
        updateShippingUI();
    }

    /* ── goToCheckout — injectar custo de envio na URL ── */
    (function patchCheckout() {
        const _wait = setInterval(() => {
            if (typeof window.goToCheckout !== 'function') return;
            clearInterval(_wait);

            const _orig = window.goToCheckout.bind(window);
            window.goToCheckout = function () {
                if (!Array.isArray(window.cart) || window.cart.length === 0) {
                    _orig();
                    return;
                }
                const net = getCartNet();
                const shipping = getShippingCost(net);
                const cartParam = encodeURIComponent(JSON.stringify(window.cart));
                window.location.href = `checkout.html?cart=${cartParam}&shipping=${shipping}&currency=${_settings.currency}`;
            };
        }, 100);
    })();

    /* ── Init ── */
    function init() {
        /* Se o Supabase ainda não carregou, esperar */
        if (typeof window.supabase === 'undefined') {
            const script = document.querySelector('script[src*="supabase-js"]');
            if (script) {
                script.addEventListener('load', loadSettings);
            } else {
                /* Sem Supabase — usar defaults */
                setTimeout(() => {
                    setDefaultShippingUI();
                    patchUpdateCartUI();
                }, 500);
            }
            return;
        }
        loadSettings();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    /* ── API pública (opcional, para debug) ── */
    window.nucaBridge = {
        getSettings: () => ({ ..._settings }),
        refresh: loadSettings,
        updateShippingUI,
    };

})();
