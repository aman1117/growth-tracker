package handlers

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"strings"
	"testing"
	"time"

	"github.com/aman1117/backend/internal/config"
	"github.com/aman1117/backend/pkg/models"
	"github.com/golang-jwt/jwt/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newTestTokenService(secret string, ttl time.Duration) *TokenService {
	return NewTokenService(&config.JWTConfig{SecretKey: secret, AccessTokenTTL: ttl, RefreshTokenTTL: 7 * 24 * time.Hour})
}

func TestTokenService_GenerateAndParseRoundTrip(t *testing.T) {
	svc := newTestTokenService("round-trip-secret", 2*time.Hour)
	user := &models.User{ID: 42, Username: "alice"}

	before := time.Now()
	token, exp, expiresIn, err := svc.Generate(user)
	require.NoError(t, err)

	assert.Equal(t, 7200, expiresIn)
	assert.WithinDuration(t, before.Add(2*time.Hour), exp, 5*time.Second)
	assert.Len(t, strings.Split(token, "."), 3)

	claims, err := svc.Parse(token)
	require.NoError(t, err)
	assert.Equal(t, uint(42), claims.UserID)
	assert.Equal(t, "alice", claims.Username)
	assert.WithinDuration(t, exp, claims.ExpiresAt.Time, time.Second)
	assert.WithinDuration(t, before, claims.IssuedAt.Time, 5*time.Second)

	unverified, _, err := jwt.NewParser().ParseUnverified(token, &Claims{})
	require.NoError(t, err)
	assert.Equal(t, jwt.SigningMethodHS256.Alg(), unverified.Method.Alg())
}

func TestTokenService_Generate_RequiresSecret(t *testing.T) {
	svc := newTestTokenService("", time.Hour)

	token, exp, expiresIn, err := svc.Generate(&models.User{ID: 1, Username: "alice"})

	require.EqualError(t, err, "JWT_SECRET_KEY is not set")
	assert.Empty(t, token)
	assert.True(t, exp.IsZero())
	assert.Zero(t, expiresIn)
}

func TestTokenService_Parse_RejectsUntrustedTokens(t *testing.T) {
	const secret = "the-right-secret"
	svc := newTestTokenService(secret, time.Hour)
	user := &models.User{ID: 9, Username: "mallory"}

	validClaims := func() *Claims {
		now := time.Now()
		return &Claims{
			UserID:   user.ID,
			Username: user.Username,
			RegisteredClaims: jwt.RegisteredClaims{
				ExpiresAt: jwt.NewNumericDate(now.Add(time.Hour)),
				IssuedAt:  jwt.NewNumericDate(now),
			},
		}
	}

	wrongSecret, _, _, err := newTestTokenService("another-secret", time.Hour).Generate(user)
	require.NoError(t, err)

	expired, _, _, err := newTestTokenService(secret, -time.Minute).Generate(user)
	require.NoError(t, err)

	ecKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(t, err)
	es256, err := jwt.NewWithClaims(jwt.SigningMethodES256, validClaims()).SignedString(ecKey)
	require.NoError(t, err)

	unsigned, err := jwt.NewWithClaims(jwt.SigningMethodNone, validClaims()).SignedString(jwt.UnsafeAllowNoneSignatureType)
	require.NoError(t, err)

	valid, _, _, err := svc.Generate(user)
	require.NoError(t, err)
	parts := strings.Split(valid, ".")
	forgedPayload, err := jwt.NewWithClaims(jwt.SigningMethodHS256, &Claims{UserID: 1, Username: "admin",
		RegisteredClaims: jwt.RegisteredClaims{ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour))}}).SigningString()
	require.NoError(t, err)
	tampered := forgedPayload + "." + parts[2]

	tests := []struct {
		name    string
		token   string
		wantErr error
		message string
	}{
		{name: "signed with another secret", token: wrongSecret, wantErr: jwt.ErrTokenSignatureInvalid},
		{name: "expired", token: expired, wantErr: jwt.ErrTokenExpired},
		{name: "payload swapped under a valid signature", token: tampered, wantErr: jwt.ErrTokenSignatureInvalid},
		{name: "non-HMAC signing method", token: es256, message: "unexpected signing method"},
		{name: "alg none", token: unsigned, message: "unexpected signing method"},
		{name: "garbage", token: "not-a-jwt", wantErr: jwt.ErrTokenMalformed},
		{name: "empty", token: "", wantErr: jwt.ErrTokenMalformed},
		{name: "three garbage segments", token: "a.b.c", wantErr: jwt.ErrTokenMalformed},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			claims, err := svc.Parse(tc.token)

			require.Error(t, err)
			assert.Nil(t, claims)
			if tc.wantErr != nil {
				assert.ErrorIs(t, err, tc.wantErr)
			}
			if tc.message != "" {
				assert.Contains(t, err.Error(), tc.message)
			}
		})
	}
}

func TestTokenService_Parse_RejectsTokensWhenSecretIsEmpty(t *testing.T) {
	// A token HMAC-signed with an empty key verifies against an empty secret, so anyone could
	// forge one if JWT_SECRET_KEY were missing (config only warns about it).
	forged, err := jwt.NewWithClaims(jwt.SigningMethodHS256, &Claims{UserID: 1, Username: "admin",
		RegisteredClaims: jwt.RegisteredClaims{ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour))}}).SignedString([]byte(""))
	require.NoError(t, err)

	claims, err := newTestTokenService("", time.Hour).Parse(forged)

	require.EqualError(t, err, "JWT_SECRET_KEY is not set")
	assert.Nil(t, claims)
}
