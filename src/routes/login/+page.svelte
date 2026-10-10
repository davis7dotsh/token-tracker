<script lang="ts">
  import { enhance } from '$app/forms';
  import type { PageProps } from './$types';
  let { form }: PageProps = $props();
  let submitting = $state(false);
</script>

<svelte:head><title>Sign in · Token tracker</title><meta name="robots" content="noindex" /></svelte:head>

<main class="login">
  <form
    method="POST"
    use:enhance={() => {
      submitting = true;
      return async ({ update }) => {
        await update();
        submitting = false;
      };
    }}
  >
    <h1>Token tracker<span>.</span></h1>
    <label for="passcode">Passcode</label>
    <input id="passcode" name="passcode" type="password" autocomplete="current-password" required maxlength="1024" />
    <p class="message" role="status">{form?.message ?? ''}</p>
    <button type="submit" disabled={submitting}>{submitting ? 'Signing in…' : 'Sign in'}</button>
  </form>
</main>

<style>
  .login {
    min-height: 100svh;
    display: grid;
    place-items: center;
    padding: 32px 24px;
  }
  form {
    width: min(100%, 340px);
  }
  h1 {
    font-size: 32px;
    letter-spacing: -1px;
    margin-bottom: 38px;
  }
  h1 span {
    color: var(--accent);
  }
  label {
    display: block;
    font-weight: 600;
    margin-bottom: 10px;
  }
  input {
    width: 100%;
    height: 46px;
    padding: 0 12px;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  .message {
    min-height: 36px;
    margin: 10px 0 0;
    font-size: 13px;
    color: var(--muted);
  }
  button {
    width: 100%;
    height: 44px;
    border-radius: 6px;
    background: var(--ink);
    color: var(--surface);
    font-weight: 600;
  }
</style>
