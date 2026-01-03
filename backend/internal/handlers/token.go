package handlers

import (
	"errors"
	"time"

	"github.com/aman1117/backend/internal/config"
	"github.com/aman1117/backend/pkg/models"
	"github.com/golang-jwt/jwt/v5"
)

// Claims represents JWT claims
type Claims struct {
	UserID   uint   `json:"user_id"`
	Username string `json:"username"`
	jwt.RegisteredClaims
}

// TokenService handles JWT token operations
type TokenService struct {
	secretKey  string
	accessTTL  time.Duration
	refreshTTL time.Duration
}

// NewTokenService creates a new TokenService
func NewTokenService(cfg *config.JWTConfig) *TokenService {
	return &TokenService{
		secretKey:  cfg.SecretKey,
		accessTTL:  cfg.AccessTokenTTL,
		refreshTTL: cfg.RefreshTokenTTL,
	}
}

// Generate generates a new JWT token for a user
func (s *TokenService) Generate(user *models.User) (string, time.Time, int, error) {
	now := time.Now()
	exp := now.Add(s.accessTTL)

	claims := &Claims{
		UserID:   user.ID,
		Username: user.Username,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(exp),
			IssuedAt:  jwt.NewNumericDate(now),
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	if s.secretKey == "" {
		return "", time.Time{}, 0, errors.New("JWT_SECRET_KEY is not set")
	}

	signed, err := token.SignedString([]byte(s.secretKey))
	if err != nil {
		return "", time.Time{}, 0, err
	}

	expiresIn := int(s.accessTTL.Seconds())
	return signed, exp, expiresIn, nil
}

// Parse parses and validates a JWT token
func (s *TokenService) Parse(tokenStr string) (*Claims, error) {
	claims := &Claims{}

	token, err := jwt.ParseWithClaims(tokenStr, claims, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return []byte(s.secretKey), nil
	})

	if err != nil {
		return nil, err
	}

	if !token.Valid {
		return nil, errors.New("invalid token")
	}

	return claims, nil
}
