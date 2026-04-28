/**
 * nuca-bridge.js
 * Liga o painel de admin (Supabase) à loja (index.html) e checkout.
 * Aplica: modo manutenção, envio, IVA, moeda, envio grátis, e regista zona de envio.
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

            // Carregar configurações da loja
            const { data: shop, error: shopError } = await _supabase
                .from('shop_settings')
                .select('maintenance_mode,maintenance_message,currency,prices_include_vat')
                .eq('id', 1)
                .single();

            if (!shopError && shop) {
                _settings.maintenanceMode = shop.maintenance_mode || false;
                _settings.maintenanceMessage = shop.maintenance_message || _settings.maintenanceMessage;
                _settings.currency = shop.currency || 'EUR';
                _settings.pricesIncludeVat = shop.prices_include_vat !== false;
                console.log('[nuca-bridge] Configurações da loja carregadas');
            }

            // Carregar configurações de envio
            const { data: shipSettings, error: shipError } = await _supabase
                .from('shipping_settings')
                .select('free_shipping_enabled,free_shipping_threshold')
                .eq('id', 1)
                .single();

            if (!shipError && shipSettings) {
                _settings.freeShippingEnabled = shipSettings.free_shipping_enabled || false;
                _settings.freeShippingThreshold = parseFloat(shipSettings.free_shipping_threshold) || 50;
                console.log('[nuca-bridge] Configurações de envio carregadas:', {
                    freeEnabled: _settings.freeShippingEnabled,
                    threshold: _settings.freeShippingThreshold
                });
            }

            // Carregar zonas de envio
            const { data: zones, error: zonesError } = await _supabase
                .from('shipping_zones')
                .select('*')
                .order('sort_order', { ascending: true });

            if (!zonesError && zones && zones.length > 0) {
                _settings.shippingZones = zones;
                
                // Definir preço de envio padrão (Portugal Continental)
                const ptZone = zones.find(z => 
                    z.name.toLowerCase().includes('portugal') ||
                    z.name.toLowerCase().includes('continental') ||
                    z.name.toLowerCase().includes('nacional')
                ) || zones[0];
                
                if (ptZone) {
                    _settings.defaultShippingPrice = parseFloat(ptZone.price) || 3.99;
                }
                console.log('[nuca-bridge] Zonas de envio carregadas:', zones.length);
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
            { id: 'continental', name: 'Portugal Continental', delivery_time: '2–5 dias úteis', price: 3.99, sort_order: 0 },
            { id: 'ilhas', name: 'Açores / Madeira', delivery_time: '4–8 dias úteis', price: 6.99, sort_order: 1 },
            { id: 'europa', name: 'Europa', delivery_time: '5–10 dias úteis', price: 12.99, sort_order: 2 },
            { id: 'internacional', name: 'Internacional', delivery_time: '7–15 dias úteis', price: 19.99, sort_order: 3 }
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
        // Se tiver zona específica, calcular com base nela
        if (zoneId && _settings.shippingZones.length > 0) {
            const zone = _settings.shippingZones.find(z => String(z.id) === String(zoneId));
            if (zone) {
                const isNational = zone.name.toLowerCase().includes('portugal') || 
                                   zone.name.toLowerCase().includes('continental') ||
                                   zone.name.toLowerCase().includes('açores') ||
                                   zone.name.toLowerCase().includes('madeira') ||
                                   zone.name.toLowerCase().includes('ilhas');
                
                if (_settings.freeShippingEnabled && isNational && netTotal >= _settings.freeShippingThreshold) {
                    return 0;
                }
                return parseFloat(zone.price) || 0;
            }
        }
        
        // Fallback para cálculo padrão
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
        if (name.includes('continental')) return 'continental';
        if (name.includes('ilhas') || name.includes('açores') || name.includes('madeira')) return 'ilhas';
        if (name.includes('europa')) return 'europa';
        if (name.includes('inter') || name.includes('internacional')) return 'internacional';
        return 'outro';
    }

    /* ═══════════════════════════════════════════════════════════
       4. REGISTAR ZONA DE ENVIO NA ENCOMENDA
    ═══════════════════════════════════════════════════════════ */
    async function registerOrderZone(orderId, zoneId, shippingAddress) {
        try {
            if (!_supabase) return false;
            
            const zone = getZoneById(zoneId);
            const zoneType = getZoneType(zoneId);
            
            // Atualizar a encomenda com a zona de envio
            const { error } = await _supabase
                .from('orders')
                .update({
                    shipping_zone_id: zoneId,
                    shipping_zone_name: zone ? zone.name : null,
                    shipping_zone_type: zoneType,
                    shipping_zone_price: zone ? parseFloat(zone.price) : 0,
                    shipping_address: shippingAddress,
                    updated_at: new Date().toISOString()
                })
                .eq('id', orderId);
            
            if (error) throw error;
            
            console.log('[nuca-bridge] Zona de envio registada:', { orderId, zoneId, zoneType });
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
        const net = getCartNet();
        const shipping = getShippingCost(net);
        const total = net + shipping;

        // Atualizar valor de envio no carrinho
        const shippingEl = document.getElementById('cart-shipping-value');
        if (shippingEl) {
            if (shipping === 0) {
                shippingEl.textContent = 'Grátis';
                shippingEl.style.color = '#10B981';
            } else {
                shippingEl.textContent = formatCurrency(shipping);
                shippingEl.style.color = '';
            }
        }

        // Atualizar linha de progresso para envio grátis
        const threshEl = document.getElementById('cart-shipping-threshold');
        if (threshEl && _settings.freeShippingEnabled) {
            if (shipping > 0) {
                const remaining = _settings.freeShippingThreshold - net;
                threshEl.style.display = 'block';
                threshEl.textContent = `Faltam ${formatCurrency(Math.max(0, remaining))} para envio grátis`;
                threshEl.style.color = '#10B981';
            } else {
                threshEl.style.display = 'none';
            }
        } else if (threshEl) {
            threshEl.style.display = 'none';
        }

        // Atualizar total final
        const totalEl = document.getElementById('cart-total');
        if (totalEl) totalEl.textContent = formatCurrency(total);

        // Atualizar linha de IVA
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

        // Atualizar subtotal se existir elemento
        const subtotalEl = document.getElementById('cart-subtotal');
        if (subtotalEl) subtotalEl.textContent = formatCurrency(net);
        
        // Atualizar desconto
        const discountEl = document.getElementById('cart-discount');
        if (discountEl) {
            const originalTotal = window.cart?.reduce((s, item) => s + (item.originalPrice || item.price), 0) || net;
            const discount = originalTotal - net;
            if (discount > 0) {
                discountEl.textContent = `-${formatCurrency(discount)}`;
                discountEl.style.color = '#10B981';
            } else {
                discountEl.textContent = formatCurrency(0);
                discountEl.style.color = '';
            }
        }

        // Notificar listeners (para checkout, etc.)
        notifyListeners('shippingUpdated', { net, shipping, total });
    }

    function updateMarqueeMessage() {
        if (!_settings.freeShippingEnabled) return;
        const threshold = _settings.freeShippingThreshold;
        const message = `ENVIO GRÁTIS EM COMPRAS ACIMA DE ${formatCurrency(threshold)} • PEÇAS ESSENCIAIS • DESIGN ATEMPORAL • COLEÇÃO ESTAÇÕES DO ANO •&nbsp;`;
        
        document.querySelectorAll('.marquee-content').forEach(el => {
            el.innerHTML = message.repeat(2);
        });
    }

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

    /* ═══════════════════════════════════════════════════════════
       6. SISTEMA DE EVENTOS/LISTENERS
    ═══════════════════════════════════════════════════════════ */
    function addListener(event, callback) {
        _listeners.push({ event, callback });
    }

    function notifyListeners(event, data) {
        _listeners.forEach(l => {
            if (l.event === event) {
                try {
                    l.callback(data);
                } catch (e) {
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
                
                const net = getCartNet();
                const shipping = getShippingCost(net);
                const cartParam = encodeURIComponent(JSON.stringify(window.cart));
                const zonesParam = encodeURIComponent(JSON.stringify(_settings.shippingZones));
                const freeShippingParam = _settings.freeShippingEnabled ? 
                    `&freeShipping=${_settings.freeShippingThreshold}` : '';
                
                window.location.href = `checkout.html?cart=${cartParam}&shipping=${shipping}&currency=${_settings.currency}&zones=${zonesParam}${freeShippingParam}`;
            };
        }, 100);
    }

    /* ═══════════════════════════════════════════════════════════
       9. EXPORTAÇÕES PÚBLICAS PARA CHECKOUT
    ═══════════════════════════════════════════════════════════ */
    function getShippingZones() {
        return [..._settings.shippingZones];
    }

    function isFreeShippingEnabled() {
        return _settings.freeShippingEnabled;
    }

    function getFreeShippingThreshold() {
        return _settings.freeShippingThreshold;
    }

    function getSettings() {
        return { ..._settings };
    }

    async function refreshSettings() {
        await loadSettings();
    }

    /* ═══════════════════════════════════════════════════════════
       10. INICIALIZAÇÃO
    ═══════════════════════════════════════════════════════════ */
    function init() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                initSupabase();
                loadSettings();
                patchUpdateCartUI();
                patchCheckout();
            });
        } else {
            initSupabase();
            loadSettings();
            patchUpdateCartUI();
            patchCheckout();
        }
    }

    init();

    /* ═══════════════════════════════════════════════════════════
       11. API PÚBLICA
    ═══════════════════════════════════════════════════════════ */
    window.nucaBridge = {
        // Configurações
        getSettings,
        refreshSettings,
        getShippingZones,
        isFreeShippingEnabled,
        getFreeShippingThreshold,
        
        // Cálculos
        getShippingCost,
        formatCurrency,
        getZoneById,
        getZoneType,
        
        // Registo de zona na encomenda
        registerOrderZone,
        
        // UI
        updateShippingUI,
        
        // Eventos
        addListener,
        
        // Dados
        getCartNet
    };

    console.log('[nuca-bridge] Inicializado com sucesso');
})();
