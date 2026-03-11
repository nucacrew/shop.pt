import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Buscar a chave do Stripe (que guardaste no Passo 1)
const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY');

// CORS - permite que o teu site aceda à função
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  // Responder a pedidos OPTIONS (CORS preflight)
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Ler dados do pedido (quem o cliente é, quanto custa, etc.)
    const body = await req.json();
    
    console.log('A criar pagamento Stripe para:', body.identifier);

    // PREPARAR dados para o Stripe
    // Stripe trabalha em CÊNTIMOS (€55.00 = 5500 centimos)
    const amountInCents = Math.round(parseFloat(body.amount) * 100);
    
    const params = new URLSearchParams({
      // Métodos de pagamento
      'payment_method_types[]': 'card',
      
      // Produto
      'line_items[0][price_data][currency]': 'eur',
      'line_items[0][price_data][product_data][name]': body.description || 'Encomenda NUCA',
      'line_items[0][price_data][unit_amount]': amountInCents.toString(),
      'line_items[0][quantity]': '1',
      
      // Tipo: pagamento único (não subscrição)
      'mode': 'payment',
      
      // URLs de retorno (quando pagamento termina)
      'success_url': `https://zrzlyrobfzlcxcbokgnl.supabase.co/success?order=${body.identifier}&session_id={CHECKOUT_SESSION_ID}`,
      'cancel_url': `https://zrzlyrobfzlcxcbokgnl.supabase.co/checkout?order=${body.identifier}&canceled=true`,
      
      // Metadados (para identificar a encomenda depois)
      'metadata[order_id]': body.identifier,
      'metadata[customer_email]': body.customer?.email || '',
      'metadata[customer_name]': body.customer?.name || '',
      
      // Email do cliente (Stripe envia recibo)
      'customer_email': body.customer?.email || '',
    });

    // CHAMAR API DO STRIPE
    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString()
    });

    const data = await response.json();

    // Se deu erro no Stripe
    if (!response.ok) {
      console.error('Erro Stripe:', data);
      throw new Error(data.error?.message || 'Erro ao criar checkout');
    }

    // SUCESSO - devolver link do Stripe
    return new Response(
      JSON.stringify({
        success: true,
        url: data.url,           // Link para o cliente pagar
        session_id: data.id,     // ID da sessão (guardar na BD)
        identifier: body.identifier,
      }), 
      { 
        status: 200, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );

  } catch (error) {
    console.error('Erro:', error);
    return new Response(
      JSON.stringify({ error: error.message }), 
      { status: 500, headers: corsHeaders }
    );
  }
});
