/**
 * nuca-bridge.js
 * Liga o painel de admin (Supabase) à loja (index.html) e checkout.
 * Aplica: modo manutenção, envio, IVA, moeda, envio grátis, e regista zona de envio.
 * Inclui correções: seleção visual de packs e cálculo correto de preços com desconto.
 */

(function () {
    'use strict';

    const SUPABASE_URL = 'https://zrzlyrobfzlcxcbokgnl.supabase.co';
    const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inpyemx5cm9iZnpsY3hjYm9rZ25sIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxNTg3NDcsImV4cCI6MjA4ODczNDc0N30.LlCGKSu1O4oYlqEs1U04xpFfT5xH2qJVc6wGwFdtRsY';

    let _supabase = null;
    let _listeners = [];

    /* ── Estado interno ── */
    let _settings = {
        freeShippingEnabled: false,
        freeShippingThreshold: 50,
        defaultShippingPrice: 3.99,
        pricesIncludeVat: true,
        currency: 'EUR',
        maintenanceMode: false,
        maintenanceMessage: 'A loja está temporariamente em manutenção. Volte em breve!',
        shippingZones: []
    };

    /* ═══════════════════════════════════════════════════════════
       1. INICIALIZAÇÃO DO SUPABASE
    ═══════════════════════════════════════════════════════════ */
    function initSupabase() {
        if (window.supabase && !_supabase) {
            try {
                _supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
                console.log('[nuca-bridge] Supabase inicializado');
                return true;
            } catch (e) {
                console.error('[nuca-bridge] Erro ao inicializar Supabase:', e);
                return false;
            }
        }
        return false;
    }

    /* ═══════════════════════════════════════════════════════════
       2. CARREGAR CONFIGURAÇÕES DO SUPABASE
    ═══════════════════════════════════════════════════════════ */
    async function loadSettings() {
        try {
            if (!_supabase && !initSupabase()) {
                console.warn('[nuca-bridge] Supabase não disponível. Usando configurações padrão.');
                applyMaintenanceMode();
                notifyListeners('settingsLoaded');
                return;
            }

            const { data: shop, error: shopError } = await _supabase
                .from('shop_settings')
                .select('maintenance_mode,maintenance_message,currency,prices_include_vat')
                .eq('id', 1)
                .single();

            if (!shopError && shop) {
                _settings.maintenanceMode    = shop.maintenance_mode || false;
                _settings.maintenanceMessage = shop.maintenance_message || _settings.maintenanceMessage;
                _settings.currency           = shop.currency || 'EUR';
                _settings.pricesIncludeVat   = shop.prices_include_vat !== false;
            }

            const { data: shipSettings, error: shipError } = await _supabase
                .from('shipping_settings')
                .select('free_shipping_enabled,free_shipping_threshold')
                .eq('id', 1)
                .single();

            if (!shipError && shipSettings) {
                _settings.freeShippingEnabled   = shipSettings.free_shipping_enabled || false;
                _settings.freeShippingThreshold = parseFloat(shipSettings.free_shipping_threshold) || 50;
            }

            const { data: zones, error: zonesError } = await _supabase
                .from('shipping_zones')
                .select('*')
                .order('sort_order', { ascending: true });

            if (!zonesError && zones && zones.length > 0) {
                _settings.shippingZones = zones;
                const ptZone = zones.find(z =>
                    z.name.toLowerCase().includes('portugal') ||
                    z.name.toLowerCase().includes('continental') ||
                    z.name.toLowerCase().includes('nacional')
                ) || zones[0];
                if (ptZone) _settings.defaultShippingPrice = parseFloat(ptZone.price) || 3.99;
            } else {
                useDefaultZones();
            }

        } catch (err) {
            console.warn('[nuca-bridge] Erro ao carregar configurações:', err.message);
            useDefaultZones();
        } finally {
            applyMaintenanceMode();
            updateMarqueeMessage();
            notifyListeners('settingsLoaded');
        }
    }

    function useDefaultZones() {
        _settings.shippingZones = [
            { id: 'continental',   name: 'Portugal Continental', delivery_time: '2–5 dias úteis',  price: 3.99,  sort_order: 0 },
            { id: 'ilhas',         name: 'Açores / Madeira',     delivery_time: '4–8 dias úteis',  price: 6.99,  sort_order: 1 },
            { id: 'europa',        name: 'Europa',               delivery_time: '5–10 dias úteis', price: 12.99, sort_order: 2 },
            { id: 'internacional', name: 'Internacional',        delivery_time: '7–15 dias úteis', price: 19.99, sort_order: 3 }
        ];
        _settings.defaultShippingPrice = 3.99;
    }

    /* ═══════════════════════════════════════════════════════════
       3. FUNÇÕES DE UTILIDADE PÚBLICAS
    ═══════════════════════════════════════════════════════════ */
    function formatCurrency(amount) {
        const symbol = _settings.currency === 'USD' ? '$' : _settings.currency === 'GBP' ? '£' : '€';
        return symbol + parseFloat(amount).toFixed(2);
    }

    function getCartNet() {
        if (typeof window.cart === 'undefined' || !Array.isArray(window.cart)) return 0;
        return window.cart.reduce((s, item) => s + (parseFloat(item.price) || 0), 0);
    }

    function getShippingCost(netTotal, zoneId = null) {
        if (zoneId && _settings.shippingZones.length > 0) {
            const zone = _settings.shippingZones.find(z => String(z.id) === String(zoneId));
            if (zone) {
                if (_settings.freeShippingEnabled && netTotal >= _settings.freeShippingThreshold) return 0;
                return parseFloat(zone.price) || 0;
            }
        }
        if (_settings.freeShippingEnabled && netTotal >= _settings.freeShippingThreshold) return 0;
        return _settings.defaultShippingPrice;
    }

    function getZoneById(zoneId) {
        return _settings.shippingZones.find(z => String(z.id) === String(zoneId)) || null;
    }

    function getZoneType(zoneId) {
        const zone = getZoneById(zoneId);
        if (!zone) return 'desconhecido';
        const name = zone.name.toLowerCase();
        if (name.includes('continental'))                                          return 'continental';
        if (name.includes('ilhas') || name.includes('açores') || name.includes('madeira')) return 'ilhas';
        if (name.includes('europa'))                                               return 'europa';
        if (name.includes('inter') || name.includes('internacional'))              return 'internacional';
        return 'outro';
    }

    /* ═══════════════════════════════════════════════════════════
       4. REGISTAR ZONA DE ENVIO NA ENCOMENDA
    ═══════════════════════════════════════════════════════════ */
    async function registerOrderZone(orderId, zoneId, shippingAddress) {
        try {
            if (!_supabase) return false;
            const zone     = getZoneById(zoneId);
            const zoneType = getZoneType(zoneId);
            const { error } = await _supabase
                .from('orders')
                .update({
                    shipping_zone_id:    zoneId,
                    shipping_zone_name:  zone ? zone.name : null,
                    shipping_zone_type:  zoneType,
                    shipping_zone_price: zone ? parseFloat(zone.price) : 0,
                    shipping_address:    shippingAddress,
                    updated_at:          new Date().toISOString()
                })
                .eq('id', orderId);
            if (error) throw error;
            return true;
        } catch (err) {
            console.error('[nuca-bridge] Erro ao registar zona de envio:', err);
            return false;
        }
    }

    /* ═══════════════════════════════════════════════════════════
       5. FUNÇÕES DE UI
    ═══════════════════════════════════════════════════════════ */
    function updateShippingUI() {
        const net      = getCartNet();
        const shipping = getShippingCost(net);
        const total    = net + shipping;

        const shippingEl = document.getElementById('cart-shipping-value');
        if (shippingEl) {
            if (shipping === 0) {
                shippingEl.textContent  = 'Grátis';
                shippingEl.style.color  = '#10B981';
            } else {
                shippingEl.textContent  = formatCurrency(shipping);
                shippingEl.style.color  = '';
            }
        }

        const threshEl = document.getElementById('cart-shipping-threshold');
        if (threshEl && _settings.freeShippingEnabled) {
            if (shipping > 0) {
                const remaining       = _settings.freeShippingThreshold - net;
                threshEl.style.display = 'block';
                threshEl.textContent   = `Faltam ${formatCurrency(Math.max(0, remaining))} para envio grátis`;
                threshEl.style.color   = '#10B981';
            } else {
                threshEl.style.display = 'none';
            }
        } else if (threshEl) {
            threshEl.style.display = 'none';
        }

        const totalEl = document.getElementById('cart-total');
        if (totalEl) totalEl.textContent = formatCurrency(total);

        const vatRow   = document.getElementById('cart-vat-row');
        const vatLabel = document.getElementById('cart-vat-label');
        if (vatRow && vatLabel) {
            if (_settings.pricesIncludeVat) {
                vatRow.style.display  = 'flex';
                vatLabel.textContent  = 'IVA incluído nos preços';
            } else {
                vatRow.style.display  = 'none';
            }
        }

        const subtotalEl = document.getElementById('cart-subtotal');
        if (subtotalEl) {
            // FIX — subtotal mostra o valor original (antes de desconto)
            const originalTotal = Array.isArray(window.cart)
                ? window.cart.reduce((s, item) => s + (parseFloat(item.originalPrice) || parseFloat(item.price) || 0), 0)
                : net;
            subtotalEl.textContent = formatCurrency(originalTotal);
        }

        const discountEl = document.getElementById('cart-discount');
        if (discountEl) {
            const originalTotal = Array.isArray(window.cart)
                ? window.cart.reduce((s, item) => s + (parseFloat(item.originalPrice) || parseFloat(item.price) || 0), 0)
                : net;
            const discount = originalTotal - net;
            if (discount > 0) {
                discountEl.textContent = `-${formatCurrency(discount)}`;
                discountEl.style.color = '#10B981';
                // FIX — mostrar linha de desconto só quando há desconto real
                const discountRow = document.getElementById('cart-discount-row');
                if (discountRow) discountRow.style.display = 'flex';
            } else {
                discountEl.textContent = formatCurrency(0);
                discountEl.style.color = '';
                // FIX — esconder linha de desconto quando não há desconto
                const discountRow = document.getElementById('cart-discount-row');
                if (discountRow) discountRow.style.display = 'none';
            }
        }

        notifyListeners('shippingUpdated', { net, shipping, total });
    }

    function updateMarqueeMessage() {
        if (!_settings.freeShippingEnabled) return;
        const threshold = _settings.freeShippingThreshold;
        const message   = `ENVIO GRÁTIS EM COMPRAS ACIMA DE ${formatCurrency(threshold)} — TODAS AS ZONAS • PEÇAS ESSENCIAIS • DESIGN ATEMPORAL • COLEÇÃO ESTAÇÕES DO ANO •&nbsp;`;
        document.querySelectorAll('.marquee-content').forEach(el => {
            el.innerHTML = message.repeat(2);
        });
    }

    function applyMaintenanceMode() {
        const overlay = document.getElementById('nuca-maintenance-overlay');
        if (!overlay) return;
        if (_settings.maintenanceMode) {
            const msgEl = document.getElementById('nuca-maintenance-msg');
            if (msgEl && _settings.maintenanceMessage) msgEl.textContent = _settings.maintenanceMessage;
            overlay.style.display      = 'flex';
            document.body.style.overflow = 'hidden';
        } else {
            overlay.style.display      = 'none';
            document.body.style.overflow = '';
        }
    }

    /* ═══════════════════════════════════════════════════════════
       6. SISTEMA DE EVENTOS / LISTENERS
    ═══════════════════════════════════════════════════════════ */
    function addListener(event, callback) {
        _listeners.push({ event, callback });
    }

    function notifyListeners(event, data) {
        _listeners.forEach(l => {
            if (l.event === event) {
                try { l.callback(data); } catch (e) {
                    console.error(`[nuca-bridge] Erro no listener ${event}:`, e);
                }
            }
        });
    }

    /* ═══════════════════════════════════════════════════════════
       7. PATCH DA FUNÇÃO UPDATE CART UI
    ═══════════════════════════════════════════════════════════ */
    function patchUpdateCartUI() {
        if (typeof window.updateCartUI !== 'function') return;
        if (window.__nucaBridgePatched) return;
        window.__nucaBridgePatched = true;

        const _original = window.updateCartUI.bind(window);
        window.updateCartUI = function () {
            _original();
            setTimeout(updateShippingUI, 0);
        };

        updateShippingUI();
    }

    /* ═══════════════════════════════════════════════════════════
       8. PATCH DO GO TO CHECKOUT
       FIX — passa zonas e configurações de envio ao checkout
    ═══════════════════════════════════════════════════════════ */
    function patchCheckout() {
        const checkInterval = setInterval(() => {
            if (typeof window.goToCheckout !== 'function') return;
            clearInterval(checkInterval);

            const _orig = window.goToCheckout.bind(window);
            window.goToCheckout = function () {
                if (!Array.isArray(window.cart) || window.cart.length === 0) {
                    if (_orig) _orig();
                    return;
                }
                const net            = getCartNet();
                const shipping       = getShippingCost(net);
                const cartParam      = encodeURIComponent(JSON.stringify(window.cart));
                const zonesParam     = encodeURIComponent(JSON.stringify(_settings.shippingZones));
                const freeShippingParam = _settings.freeShippingEnabled
                    ? `&freeShipping=${_settings.freeShippingThreshold}` : '';
                window.location.href = `checkout.html?cart=${cartParam}&shipping=${shipping}&currency=${_settings.currency}&zones=${zonesParam}${freeShippingParam}`;
            };
        }, 100);
    }

    /* ═══════════════════════════════════════════════════════════
       9. CORREÇÕES DE PACKS
       — Seleção visual + preços corretos com desconto
       — Aguarda que todas as funções globais estejam prontas
    ═══════════════════════════════════════════════════════════ */
    function patchPackFunctions() {
        const checkInterval = setInterval(() => {

            // Aguarda que todas as variáveis e funções do index.html estejam disponíveis
            if (
                typeof window.selectedPackSizes    === 'undefined' ||
                typeof window.currentPack          === 'undefined' ||
                typeof window.cart                 === 'undefined' ||
                typeof window.showNotification     !== 'function'  ||
                typeof window.updateCartUI         !== 'function'  ||
                typeof window.closePackModal       !== 'function'  ||
                typeof window.toggleCart           !== 'function'  ||
                typeof window.allProducts          === 'undefined'
            ) return; // ainda não está tudo pronto

            clearInterval(checkInterval);
            console.log('[nuca-bridge] A aplicar correções de packs...');

            // Fallbacks seguros para funções do index.html
            const getSeasonKey = typeof window.getSeasonKey === 'function'
                ? window.getSeasonKey
                : (s) => ({ 'Primavera': 'primavera', 'Verão': 'verao', 'Outono': 'outono', 'Inverno': 'inverno' }[s] || s.toLowerCase());

            const seasonColors = window.seasonColors || {
                'Primavera': { name: 'Menta', hex: '#98D8C8' },
                'Verão':     { name: 'Sol',   hex: '#F7DC6F' },
                'Outono':    { name: 'Terra', hex: '#E59866' },
                'Inverno':   { name: 'Gelo',  hex: '#AED6F1' }
            };

            /* ── FIX: Seleção visual de tamanho ── */
            window.selectProductSize = function (productId, size) {
                window.selectedPackSizes[productId] = size;

                document.querySelectorAll(`.pack-size-btn-styled[data-product="${productId}"]`).forEach(btn => {
                    const isActive = btn.dataset.size === size;
                    btn.classList.toggle('active', isActive);
                    btn.style.backgroundColor = isActive ? '#556B4F' : '#fff';
                    btn.style.color           = isActive ? '#D8C6A5' : '#556B4F';
                    btn.style.borderColor     = isActive ? '#556B4F' : 'rgba(85,107,79,0.35)';
                });

                // Atualiza select de meias se existir
                document.querySelectorAll('select.pack-meias-select').forEach(sel => {
                    const oc = sel.getAttribute('onchange') || '';
                    if (oc.includes(productId)) sel.value = size;
                });
            };

            /* ── FIX: Seleção visual de cor ── */
            window.selectProductColor = function (productId, color) {
                window.selectedPackColors[productId] = color;
                document.querySelectorAll(`.pack-color-dot[data-product="${productId}"]`).forEach(dot => {
                    dot.classList.toggle('active', dot.dataset.color === color);
                });
            };

            /* ── FIX: Seleção visual de estação ── */
            window.selectProductSeason = function (productId, season) {
                window.selectedPackSeasons[productId] = season;
                document.querySelectorAll(`.pack-season-btn[data-product="${productId}"]`).forEach(btn => {
                    btn.classList.toggle('active', btn.dataset.season === season);
                });
            };

            /* ── FIX: addPackToCart — desconto aplicado corretamente ── */
            window.addPackToCart = function () {
                const pack = window.currentPack;
                if (!pack) return;

                let allValid    = true;
                const packProducts = pack.items
                    .map(id => window.allProducts.find(p => p.id === id))
                    .filter(Boolean);

                // Validações
                for (const product of packProducts) {
                    if (pack.type === 'seasons' && product.hasSeasons && !window.selectedPackSeasons[product.id]) {
                        window.showNotification('warning', 'Seleção incompleta', `Por favor escolhe a estação para ${product.name}.`);
                        allValid = false;
                        break;
                    }
                    if (product.colors && product.colors.length > 0 && !product.hasSeasons && !window.selectedPackColors[product.id]) {
                        window.showNotification('warning', 'Seleção incompleta', `Por favor escolhe a cor para ${product.name}.`);
                        allValid = false;
                        break;
                    }
                    if (product.sizes && product.sizes[0] !== 'Único' && !window.selectedPackSizes[product.id]) {
                        window.showNotification('warning', 'Seleção incompleta', `Por favor escolhe o tamanho para ${product.name}.`);
                        allValid = false;
                        break;
                    }
                }

                if (!allValid) return;

                // FIX — desconto distribuído proporcionalmente por cada item
                const discountFactor = (100 - pack.discount) / 100;

                packProducts.forEach(product => {
                    let imageUrl    = '';
                    let colorName   = null;
                    let productName = product.name;

                    if (pack.type === 'seasons' && product.hasSeasons && window.selectedPackSeasons[product.id]) {
                        const seasonKey = getSeasonKey(window.selectedPackSeasons[product.id]);
                        if (product.seasonImages && product.seasonImages[seasonKey]) {
                            imageUrl = product.seasonImages[seasonKey]?.front || '';
                        }
                        colorName    = seasonColors[window.selectedPackSeasons[product.id]]?.name;
                        productName += ` - ${window.selectedPackSeasons[product.id]}`;
                    } else if (window.selectedPackColors[product.id]) {
                        const colorObj = product.colors.find(c => c.name === window.selectedPackColors[product.id]);
                        if (colorObj && product.images[colorObj.key]) {
                            imageUrl = product.images[colorObj.key]?.front || '';
                        }
                        colorName = window.selectedPackColors[product.id];
                    } else if (product.images) {
                        const firstKey = Object.keys(product.images)[0];
                        imageUrl = product.images[firstKey]?.front || '';
                    }

                    window.cart.push({
                        id:          `${product.id}_pack_${Date.now()}_${Math.random()}`,
                        name:        productName,
                        price:       parseFloat((product.basePrice * discountFactor).toFixed(2)),
                        originalPrice: product.basePrice,
                        size:        window.selectedPackSizes[product.id] || (product.sizes && product.sizes[0] === 'Único' ? 'Único' : null),
                        color:       colorName,
                        image:       imageUrl,
                        isPackItem:  true
                    });
                });

                // Itens grátis (preço 0)
                if (pack.freeGiftIds && pack.freeGiftIds.length > 0) {
                    pack.freeGiftIds.forEach(id => {
                        const p = window.allProducts.find(x => x.id === id);
                        if (!p) return;
                        let img = '';
                        if (p.images) {
                            const k = Object.keys(p.images)[0];
                            img = p.images[k]?.front || '';
                        }
                        window.cart.push({
                            id:           `${p.id}_free_${Date.now()}`,
                            name:         `${p.name} (Oferta)`,
                            price:        0,
                            originalPrice: p.basePrice,
                            size:         null,
                            color:        null,
                            image:        img,
                            isPackItem:   true,
                            isFreeGift:   true
                        });
                    });
                }

                window.updateCartUI();
                if (typeof window.closePackModal === 'function') window.closePackModal();
                setTimeout(() => {
                    window.showNotification('success', 'Pack Adicionado!', `${pack.name} foi adicionado ao carrinho.`);
                    if (typeof window.toggleCart === 'function') window.toggleCart();
                }, 350);
            };

            console.log('[nuca-bridge] Correções de packs aplicadas com sucesso.');

        }, 200);
    }

    /* ═══════════════════════════════════════════════════════════
       10. EXPORTAÇÕES PÚBLICAS
    ═══════════════════════════════════════════════════════════ */
    function getShippingZones()       { return [..._settings.shippingZones]; }
    function isFreeShippingEnabled()  { return _settings.freeShippingEnabled; }
    function getFreeShippingThreshold() { return _settings.freeShippingThreshold; }
    function getSettings()            { return { ..._settings }; }
    async function refreshSettings()  { await loadSettings(); }

    /* ═══════════════════════════════════════════════════════════
       11. INICIALIZAÇÃO
    ═══════════════════════════════════════════════════════════ */
    function init() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                initSupabase();
                loadSettings();
                patchUpdateCartUI();
                patchCheckout();
                patchPackFunctions();
            });
        } else {
            initSupabase();
            loadSettings();
            patchUpdateCartUI();
            patchCheckout();
            patchPackFunctions();
        }
    }

    init();

    /* ═══════════════════════════════════════════════════════════
       12. API PÚBLICA
    ═══════════════════════════════════════════════════════════ */
    window.nucaBridge = {
        getSettings,
        refreshSettings,
        getShippingZones,
        isFreeShippingEnabled,
        getFreeShippingThreshold,
        getShippingCost,
        formatCurrency,
        getZoneById,
        getZoneType,
        registerOrderZone,
        updateShippingUI,
        addListener,
        getCartNet
    };

    console.log('[nuca-bridge] Inicializado com sucesso.');
})();
