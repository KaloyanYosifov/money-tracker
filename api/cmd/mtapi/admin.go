package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/KaloyanYosifov/money-tracker/api/internal/auth"
	"github.com/KaloyanYosifov/money-tracker/api/internal/db"
	"github.com/KaloyanYosifov/money-tracker/api/internal/users"
)

const adminUsage = `usage:
  mtapi admin invite --email <e> --currency <ISO> [--role admin|user]
  mtapi admin reset-totp --email <e>
  mtapi admin revoke-sessions --email <e>`

// admin runs an admin subcommand. It reads only DATABASE_URL and PUBLIC_URL.
func admin(args []string, out io.Writer) error {
	if len(args) == 0 {
		return errors.New(adminUsage)
	}
	cmd, args := args[0], args[1:]

	fs := flag.NewFlagSet("admin "+cmd, flag.ContinueOnError)
	email := fs.String("email", "", "email of the user")
	var currency, role *string
	switch cmd {
	case "invite":
		currency = fs.String("currency", "", "ISO 4217 currency code")
		role = fs.String("role", "user", "admin or user")
	case "reset-totp", "revoke-sessions":
	default:
		return errors.New(adminUsage)
	}
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *email == "" {
		return errors.New("--email is required")
	}

	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		return errors.New("DATABASE_URL is required")
	}
	publicURL := strings.TrimRight(os.Getenv("PUBLIC_URL"), "/")
	if cmd != "revoke-sessions" && publicURL == "" {
		return errors.New("PUBLIC_URL is required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	pool, err := db.Open(ctx, dbURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	store := users.NewStore(pool)

	switch cmd {
	case "invite":
		token, err := store.CreateInvite(ctx, *email, *currency, *role)
		if err != nil {
			return err
		}
		fmt.Fprintln(out, inviteURL(publicURL, token))
	case "reset-totp":
		token, err := store.ResetTOTP(ctx, *email)
		if err != nil {
			return err
		}
		fmt.Fprintln(out, inviteURL(publicURL, token))
	case "revoke-sessions":
		userID, err := store.UserIDByEmail(ctx, *email)
		if err != nil {
			return err
		}
		if err := auth.NewRefreshStore(pool).RevokeAllForUser(ctx, userID); err != nil {
			return err
		}
		fmt.Fprintf(out, "revoked all sessions of %s\n", *email)
	}
	return nil
}

func inviteURL(publicURL, token string) string {
	return publicURL + "/invite?token=" + url.QueryEscape(token)
}
