package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/joho/godotenv"
	"github.com/resend/resend-go/v4"
)

const (
	defaultListenAddress  = ":9090"
	defaultOperatorURL    = "https://sig.cento92.com/op"
	defaultClientURL      = "https://sig.cento92.com/client"
	defaultDeliveryFrom   = "relay-center@cento92.com"
	defaultEmbedOrigins   = "https://apex.cento92.com,https://rc-dev.cento92.com"
	defaultChallengeTTL   = 5 * time.Minute
	operatorCapacityState = "operator-capacity-reached"
)

type Client struct {
	Conn *websocket.Conn
	ID   string
	Role string

	writeMu sync.Mutex
}

func (c *Client) Send(message Message) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()

	return c.Conn.WriteJSON(message)
}

type joinChallenge struct {
	digest    [sha256.Size]byte
	expiresAt time.Time
	operator  *Client
	sequence  uint64
	media     MediaProfile
}

type Room struct {
	mu sync.Mutex

	Operator  *Client
	User      *Client
	Ready     bool
	Verified  bool
	Challenge *joinChallenge
	sequence  uint64
}

type Message struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type ConnectPayload struct {
	ID   string `json:"id"`
	Role string `json:"role"`
}

type JoinOfferPayload struct {
	ClientPhone     string          `json:"client_phone,omitempty"`
	ClientEmail     string          `json:"client_email,omitempty"`
	SolvedChallenge string          `json:"solved_challenge,omitempty"`
	Data            json.RawMessage `json:"data,omitempty"`
	Media           MediaProfile    `json:"media,omitempty"`

	// Accept these short names as well so a hand-written client can use the
	// protocol without knowing the browser application's field names.
	Phone     string `json:"phone,omitempty"`
	Email     string `json:"email,omitempty"`
	Challenge string `json:"challenge,omitempty"`
}

type MediaProfile struct {
	Audio bool `json:"audio"`
	Video bool `json:"video"`
}

func (p JoinOfferPayload) requestedMedia() MediaProfile {
	// Existing clients omitted media and always requested both devices.
	if !p.Media.Audio && !p.Media.Video {
		return MediaProfile{Audio: true, Video: true}
	}

	// This slice always carries voice. The operator only selects whether the
	// client should additionally be asked for camera permission.
	return MediaProfile{Audio: true, Video: p.Media.Video}
}

type PeerReadyPayload struct {
	Media MediaProfile `json:"media"`
}

func (p JoinOfferPayload) recipient() string {
	if value := strings.TrimSpace(p.ClientEmail); value != "" {
		return value
	}
	if value := strings.TrimSpace(p.Email); value != "" {
		return value
	}
	if value := strings.TrimSpace(p.ClientPhone); value != "" {
		return value
	}
	return strings.TrimSpace(p.Phone)
}

func (p JoinOfferPayload) solution() string {
	if value := strings.TrimSpace(p.SolvedChallenge); value != "" {
		return value
	}
	return strings.TrimSpace(p.Challenge)
}

func deliveryTransport(recipient string) string {
	if strings.Contains(recipient, "@") {
		return "email"
	}
	return "phone"
}

type OfferStatusPayload struct {
	State      string `json:"state"`
	HTTPStatus int    `json:"http_status"`
}

type Deliverer interface {
	Deliver(ctx context.Context, link, recipient string) (int, error)
}

type ResendDeliverer struct {
	Client *resend.Client
	From   string
}

func (d *ResendDeliverer) Deliver(
	ctx context.Context,
	link string,
	recipient string,
) (int, error) {
	if !strings.Contains(recipient, "@") {
		return http.StatusNotImplemented, fmt.Errorf(
			"phone delivery is not implemented by the current Delivery slice",
		)
	}
	if d == nil || d.Client == nil || strings.TrimSpace(d.Client.ApiKey) == "" {
		return http.StatusInternalServerError, fmt.Errorf(
			"RESEND_API_KEY is not configured",
		)
	}

	params := &resend.SendEmailRequest{
		From:    d.From,
		To:      []string{recipient},
		Subject: "RELAY CENTER EMERGENZA",
		Html: fmt.Sprintf(
			`<p>Abbiamo ricevuto la tua richiesta d'aiuto, `+
				`<a href="%s">clicca qui per parlare con un operatore</a>.</p>`,
			html.EscapeString(link),
		),
	}

	_, err := d.Client.Emails.SendWithContext(ctx, params)
	if err != nil {
		return 0, err
	}

	return http.StatusAccepted, nil
}

type Server struct {
	room         *Room
	deliverer    Deliverer
	operatorURL  string
	clientURL    string
	challengeTTL time.Duration
	logger       *log.Logger
	embedOrigins map[string]struct{}
	upgrader     websocket.Upgrader
}

type BootstrapConfig struct {
	ModuleURL     string `json:"module_url"`
	StylesheetURL string `json:"stylesheet_url"`
	SignalingURL  string `json:"signaling_url"`
}

func NewServer(deliverer Deliverer, logger *log.Logger) *Server {
	server := &Server{
		room:         &Room{},
		deliverer:    deliverer,
		operatorURL:  defaultOperatorURL,
		clientURL:    defaultClientURL,
		challengeTTL: defaultChallengeTTL,
		logger:       logger,
		embedOrigins: parseOrigins(defaultEmbedOrigins),
	}
	server.upgrader.CheckOrigin = server.originAllowed
	return server
}

func (s *Server) originAllowed(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}

	parsed, err := url.Parse(origin)
	if err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") &&
		strings.EqualFold(parsed.Host, r.Host) {
		return true
	}
	_, allowed := s.embedOrigins[strings.TrimRight(origin, "/")]
	return allowed
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/bootstrap", s.bootstrapHandler)
	mux.HandleFunc("/client", s.clientHandler)
	mux.HandleFunc("/ws", s.wsHandler)
	mux.Handle("/", http.FileServer(http.Dir("./web")))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" {
			if !s.originAllowed(r) {
				http.Error(w, "origin not allowed", http.StatusForbidden)
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Add("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Accept, Content-Type")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func (s *Server) bootstrapHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !isPrivateSource(r.RemoteAddr) {
		s.logger.Printf("rejected bootstrap request from non-private source %q", r.RemoteAddr)
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if s.operatorAtCapacity() {
		w.Header().Set("Cache-Control", "no-store")
		http.Error(
			w,
			"operator capacity reached: another operator is already connected",
			http.StatusConflict,
		)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if strings.Contains(r.Header.Get("Accept"), "application/json") {
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(s.bootstrapConfig(r)); err != nil {
			s.logger.Printf("could not encode bootstrap response: %v", err)
		}
		return
	}

	http.Redirect(w, r, s.operatorURL, http.StatusFound)
}

func (s *Server) bootstrapConfig(r *http.Request) BootstrapConfig {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if forwarded := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0]); forwarded == "http" || forwarded == "https" {
		scheme = forwarded
	}
	baseURL := scheme + "://" + r.Host
	webSocketScheme := "ws"
	if scheme == "https" {
		webSocketScheme = "wss"
	}
	return BootstrapConfig{
		ModuleURL:     baseURL + "/op/app.js",
		StylesheetURL: baseURL + "/shared/app.css",
		SignalingURL:  webSocketScheme + "://" + r.Host + "/ws",
	}
}

func parseOrigins(value string) map[string]struct{} {
	origins := make(map[string]struct{})
	for _, origin := range strings.Split(value, ",") {
		if normalized := strings.TrimRight(strings.TrimSpace(origin), "/"); normalized != "" {
			origins[normalized] = struct{}{}
		}
	}
	return origins
}

func (s *Server) operatorAtCapacity() bool {
	s.room.mu.Lock()
	defer s.room.mu.Unlock()
	return s.room.Operator != nil
}

func isPrivateSource(remoteAddress string) bool {
	host, _, err := net.SplitHostPort(remoteAddress)
	if err != nil {
		host = remoteAddress
	}
	host = strings.Trim(host, "[]")
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}

	return ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast()
}

func (s *Server) clientHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// URL fragments are deliberately not visible to this handler. The browser
	// carries the challenge through the redirect and the user app consumes it.
	s.sendOperatorStatus("client-app-requested", http.StatusSeeOther)
	http.Redirect(w, r, "/user/", http.StatusSeeOther)
}

func (s *Server) wsHandler(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.logger.Printf("error upgrading connection: %v", err)
		return
	}
	defer conn.Close()

	var registrationMessage Message
	if err := conn.ReadJSON(&registrationMessage); err != nil {
		s.logger.Printf("error reading registration: %v", err)
		return
	}
	if registrationMessage.Type != "connect" {
		s.logger.Printf("expected connect message, received %q", registrationMessage.Type)
		return
	}

	var registration ConnectPayload
	if err := json.Unmarshal(registrationMessage.Payload, &registration); err != nil {
		s.logger.Printf("invalid registration payload: %v", err)
		return
	}
	if registration.ID == "" || (registration.Role != "operator" && registration.Role != "user") {
		s.logger.Printf("invalid registration: id=%q role=%q", registration.ID, registration.Role)
		return
	}

	client := &Client{Conn: conn, ID: registration.ID, Role: registration.Role}
	if !s.register(client) {
		s.sendStatus(client, operatorCapacityState, http.StatusConflict)
		_ = conn.WriteControl(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(
				websocket.CloseTryAgainLater,
				"operator capacity reached",
			),
			time.Now().Add(time.Second),
		)
		return
	}
	defer s.unregister(client)

	for {
		var incoming Message
		if err := conn.ReadJSON(&incoming); err != nil {
			if !websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				s.logger.Printf("error reading from %s: %v", client.ID, err)
			}
			return
		}

		s.logger.Printf("received from %s: type=%s", client.ID, incoming.Type)

		if incoming.Type == "join.offer" {
			s.handleJoinOffer(client, incoming.Payload)
			continue
		}

		recipient := s.readyRecipient(client)
		if recipient == nil {
			s.logger.Printf("signaling message %q from %s rejected before peer-ready", incoming.Type, client.ID)
			continue
		}
		if err := recipient.Send(incoming); err != nil {
			s.logger.Printf("error sending to %s: %v", recipient.ID, err)
		}
	}
}

func (s *Server) register(client *Client) bool {
	s.room.mu.Lock()
	defer s.room.mu.Unlock()

	switch client.Role {
	case "operator":
		if s.room.Operator != nil {
			s.logger.Printf(
				"rejected operator at capacity: id=%s active_operator=%s",
				client.ID,
				s.room.Operator.ID,
			)
			return false
		}
		s.room.Operator = client
		s.room.Challenge = nil
		s.room.Verified = false
		s.room.Ready = false
	case "user":
		s.room.User = client
		s.room.Ready = false
	}

	s.logger.Printf("registered client: id=%s role=%s", client.ID, client.Role)
	return true
}

func (s *Server) unregister(client *Client) {
	s.room.mu.Lock()
	defer s.room.mu.Unlock()

	switch client.Role {
	case "operator":
		if s.room.Operator == client {
			s.room.Operator = nil
			s.room.Challenge = nil
			s.room.Verified = false
			s.room.Ready = false
		}
	case "user":
		if s.room.User == client {
			s.room.User = nil
			s.room.Verified = false
			s.room.Ready = false
		}
	}

	s.logger.Printf("unregistered client: id=%s role=%s", client.ID, client.Role)
}

func (s *Server) handleJoinOffer(client *Client, raw json.RawMessage) {
	var offer JoinOfferPayload
	if err := json.Unmarshal(raw, &offer); err != nil {
		s.logger.Printf("invalid join.offer from %s: %v", client.ID, err)
		s.sendStatus(client, "invalid-offer", http.StatusBadRequest)
		return
	}

	switch client.Role {
	case "operator":
		recipient := offer.recipient()
		if recipient == "" {
			s.sendStatus(client, "recipient-required", http.StatusBadRequest)
			return
		}
		go s.join(client, recipient, offer.requestedMedia())
	case "user":
		s.solveChallenge(client, offer.solution())
	}
}

// join creates the one-time challenge and hands the invitation to Delivery.
// It runs asynchronously so a slow Delivery response cannot block the
// operator's WebSocket read loop.
func (s *Server) join(
	operator *Client,
	recipient string,
	media MediaProfile,
) {
	transport := deliveryTransport(recipient)
	token, err := generateChallenge()
	if err != nil {
		s.logger.Printf("could not generate join challenge: %v", err)
		s.sendStatus(operator, "challenge-error", http.StatusInternalServerError)
		return
	}

	digest := sha256.Sum256([]byte(token))

	s.room.mu.Lock()
	if s.room.Operator != operator {
		s.room.mu.Unlock()
		return
	}
	s.room.sequence++
	sequence := s.room.sequence
	s.room.Challenge = &joinChallenge{
		digest:    digest,
		expiresAt: time.Now().Add(s.challengeTTL),
		operator:  operator,
		sequence:  sequence,
		media:     media,
	}
	s.room.Verified = false
	s.room.Ready = false
	s.room.mu.Unlock()

	s.sendStatus(operator, "challenge-created", http.StatusAccepted)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	deliveryStatus, deliveryErr := s.deliverer.Deliver(
		ctx,
		s.clientURL+"#"+token,
		recipient,
	)

	if deliveryErr != nil || deliveryStatus < 200 || deliveryStatus >= 300 {
		s.room.mu.Lock()
		if s.room.Challenge != nil && s.room.Challenge.sequence == sequence {
			s.room.Challenge = nil
		}
		s.room.mu.Unlock()

		if deliveryErr != nil {
			s.logger.Printf("challenge delivery failed: %v", deliveryErr)
		}
		if deliveryStatus == 0 {
			deliveryStatus = http.StatusBadGateway
		}
		s.sendStatus(
			operator,
			fmt.Sprintf("delivery.%s.failed", transport),
			deliveryStatus,
		)
		return
	}

	// Suppress a stale completion if another offer replaced this challenge.
	s.room.mu.Lock()
	current := s.room.Challenge != nil && s.room.Challenge.sequence == sequence
	s.room.mu.Unlock()
	if current {
		s.sendStatus(
			operator,
			fmt.Sprintf("delivery.%s.sent", transport),
			deliveryStatus,
		)
	}
}

func generateChallenge() (string, error) {
	bytes := make([]byte, 24)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(bytes), nil
}

func (s *Server) solveChallenge(user *Client, solution string) {
	digest := sha256.Sum256([]byte(solution))
	now := time.Now()

	s.room.mu.Lock()
	challenge := s.room.Challenge
	operator := s.room.Operator
	reason := "missing challenge"
	valid := false
	media := MediaProfile{Audio: true, Video: true}

	if challenge != nil {
		media = challenge.media
		switch {
		case solution == "":
			reason = "empty challenge"
		case now.After(challenge.expiresAt):
			reason = "expired challenge"
		case challenge.operator != operator:
			reason = "operator changed"
		case s.room.User != user:
			reason = "user connection was replaced"
		case subtle.ConstantTimeCompare(digest[:], challenge.digest[:]) != 1:
			reason = "challenge mismatch"
		default:
			valid = true
		}
	}

	// The challenge is one-shot. Both successful and failed attempts remove it.
	s.room.Challenge = nil
	if valid {
		s.room.Verified = true
		s.room.Ready = operator != nil && s.room.User == user
	} else {
		s.room.Verified = false
		s.room.Ready = false
	}
	ready := s.room.Ready
	s.room.mu.Unlock()

	if !valid {
		s.logger.Printf("join challenge rejected for user %s: %s", user.ID, reason)
		s.sendStatus(operator, "challenge-failed", http.StatusUnauthorized)
		s.sendStatus(user, "challenge-failed", http.StatusUnauthorized)
		return
	}

	s.logger.Printf("join challenge verified for user %s", user.ID)
	s.sendStatus(operator, "challenge-verified", http.StatusOK)
	s.sendStatus(user, "challenge-verified", http.StatusOK)
	if ready {
		s.sendPeerReady(operator, user, media)
	}
}

func (s *Server) readyRecipient(client *Client) *Client {
	s.room.mu.Lock()
	defer s.room.mu.Unlock()
	if !s.room.Ready || !s.room.Verified {
		return nil
	}

	switch client.Role {
	case "operator":
		if s.room.Operator == client {
			return s.room.User
		}
	case "user":
		if s.room.User == client {
			return s.room.Operator
		}
	}
	return nil
}

func (s *Server) sendPeerReady(
	operator *Client,
	user *Client,
	media MediaProfile,
) {
	payload, err := json.Marshal(PeerReadyPayload{Media: media})
	if err != nil {
		s.logger.Printf("could not encode peer-ready payload: %v", err)
		return
	}
	message := Message{Type: "peer-ready", Payload: payload}
	if err := operator.Send(message); err != nil {
		s.logger.Printf("error notifying operator: %v", err)
	}
	if err := user.Send(message); err != nil {
		s.logger.Printf("error notifying user: %v", err)
	}
}

func (s *Server) sendOperatorStatus(state string, status int) {
	s.room.mu.Lock()
	operator := s.room.Operator
	s.room.mu.Unlock()
	s.sendStatus(operator, state, status)
}

func (s *Server) sendStatus(client *Client, state string, status int) {
	if client == nil {
		return
	}
	payload, err := json.Marshal(OfferStatusPayload{State: state, HTTPStatus: status})
	if err != nil {
		s.logger.Printf("could not encode offer status: %v", err)
		return
	}
	if err := client.Send(Message{Type: "offer.status", Payload: payload}); err != nil {
		s.logger.Printf("could not send offer status to %s: %v", client.ID, err)
	}
}

func envOrDefault(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func main() {
	// Match the other C92 Go services: local development reads a gitignored
	// dotenv file, while an inherited process/container environment wins.
	_ = godotenv.Load(".env.local")

	logger := log.New(os.Stdout, "signaling: ", log.LstdFlags)

	deliveryClient := resend.NewCustomClient(
		&http.Client{Timeout: 10 * time.Second},
		strings.TrimSpace(os.Getenv("RESEND_API_KEY")),
	)
	deliverer := &ResendDeliverer{
		Client: deliveryClient,
		From:   envOrDefault("DELIVERY_FROM", defaultDeliveryFrom),
	}
	server := NewServer(deliverer, logger)
	server.operatorURL = envOrDefault("OPERATOR_URL", defaultOperatorURL)
	server.clientURL = envOrDefault("CLIENT_URL", defaultClientURL)
	server.embedOrigins = parseOrigins(envOrDefault("OPERATOR_EMBED_ORIGINS", defaultEmbedOrigins))

	address := envOrDefault("SIGNALING_ADDR", defaultListenAddress)
	logger.Printf("HTTP and WebSocket server started on %s", address)
	if err := http.ListenAndServe(address, server.Handler()); !errors.Is(err, http.ErrServerClosed) {
		logger.Printf("error starting server: %v", err)
	}
}
